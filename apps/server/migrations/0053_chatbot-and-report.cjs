/* eslint-disable camelcase */
/**
 * 0053 — 워크스페이스 AI 도우미: 대화 스레드 · 메시지 · 리포트.
 *
 * ⚠️ 원래 0051 이었다. 병렬 작업 중 **0052 가 먼저 적용돼** node-pg-migrate 가 거부했다
 *    ("Not run migration 0051 is preceding already run migration 0052"). 번호가 거꾸로 가면
 *    나중에 무엇이 어떤 스키마 위에서 돌았는지 못 읽기 때문이다 — 그래서 뒤로 옮겼다.
 *    프로덕션에 한 번도 안 돌았으므로 이름만 바꾸면 된다(2026-09-03).
 *
 * ## 왜 필요한가
 *
 * 제품 안에 도움말도 문의 창구도 없어서, 사용자가 막히면 사람에게 묻는 것 말고 길이 없었다.
 * 챗봇이 **대화를 기억해 이어가려면** 스레드가 저장돼야 하고, 리포트는 **나중에 "이 숫자
 * 어디서 나왔냐"에 답해야** 해서 집계 원본까지 남긴다.
 *
 * ## 격리는 두 겹이다 — 다른 이유로
 *
 *   tenant_id  → RLS 가 강제한다. 남의 **회사** 대화는 쿼리가 아예 못 본다.
 *   user_id    → 코드가 조건에 넣는다. 같은 회사 **동료**의 대화는 안 보여준다.
 *
 * 둘째 것을 RLS 로 하지 않는 이유: 정책 술어가 사용자까지 보게 만들면 0014·0021·0025·0045 와
 * 술어가 갈라지고, 그 순간 "어느 표가 어떤 규칙인지" 를 사람이 외워야 한다. 회사 격리는
 * 새는 순간이 사고지만, 동료 대화는 **정책 선택**이라 코드가 정하는 자리가 맞다.
 *
 * ## report_doc.data 를 왜 저장하나
 *
 * 리포트 본문(markdown)만 남기면 재생성도 검산도 못 한다. 숫자는 전부 결정론 집계가 낳으므로
 * 그 JSON 을 같이 두면 ① 같은 기간을 다시 뽑아 대조할 수 있고 ② 서술이 지어낸 숫자를
 * 사후에도 잡을 수 있다. HTML 은 **파생물이라 저장하지 않는다** — 저장하면 본문과 어긋난
 * 사본이 생긴다.
 *
 * @typedef {import('node-pg-migrate').MigrationBuilder} MigrationBuilder
 */

// 0014·0021·0025·0045 와 **같은** 술어여야 한다. 두 벌이 되면 한쪽만 고치게 된다.
const PREDICATE = `(tenant_id = current_setting(''app.tenant_id'', true)`
  + ` OR current_setting(''app.tenant_id'', true) = ''*'')`;

// ⚠️ 이 배열 형태를 지킬 것 — `rls-access.test.ts` 가 마이그레이션에서 RLS 표 목록을 **걷어서**
//    "스코프 없는 풀(getRawPool)로 만지지 않는가" 를 검사한다. 표 이름을 SQL 안에만 적으면
//    그 검사에서 빠져 무방비가 된다.
const TABLES = ["chat_thread", "chat_message", "report_doc"];

/** @param {MigrationBuilder} pgm */
exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS chat_thread (
      id              TEXT PRIMARY KEY,
      tenant_id       TEXT NOT NULL DEFAULT current_setting('app.tenant_id', true),
      user_id         TEXT NOT NULL,
      title           TEXT NOT NULL DEFAULT '',
      -- 오래된 메시지를 압축한 한 덩어리. 최근 것은 원문으로 싣고 그 이전만 여기로 접는다.
      summary         TEXT,
      created_at      BIGINT NOT NULL,
      updated_at      BIGINT NOT NULL,
      last_message_at BIGINT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS chat_message (
      id         TEXT PRIMARY KEY,
      thread_id  TEXT NOT NULL REFERENCES chat_thread(id) ON DELETE CASCADE,
      tenant_id  TEXT NOT NULL DEFAULT current_setting('app.tenant_id', true),
      user_id    TEXT NOT NULL,
      -- "user" | "assistant". 도구 호출 자체는 남기지 않는다 — 대화 복원에 필요한 건
      -- 사람이 읽는 두 역할뿐이고, 도구 결과는 그때의 DB 상태라 재생하면 오히려 틀린다.
      role       TEXT NOT NULL,
      content    TEXT NOT NULL,
      -- 답변에 붙은 화면 링크. 본문에서 다시 파싱하지 않게 구조로 남긴다(화이트리스트 통과분).
      links      JSONB NOT NULL DEFAULT '[]'::jsonb,
      -- 이 답을 만들 때 실제로 읽은 도움말 문서 이름. 답이 틀렸을 때 어느 문서가 원인인지 본다.
      used_docs  JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_at BIGINT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS report_doc (
      id         TEXT PRIMARY KEY,
      tenant_id  TEXT NOT NULL DEFAULT current_setting('app.tenant_id', true),
      user_id    TEXT NOT NULL,
      -- 대화 중에 만들어진 리포트면 그 스레드. 직접 호출이면 NULL.
      thread_id  TEXT,
      request    TEXT NOT NULL,
      spec       JSONB NOT NULL DEFAULT '{}'::jsonb,
      data       JSONB NOT NULL DEFAULT '{}'::jsonb,
      markdown   TEXT NOT NULL DEFAULT '',
      -- 숫자 가드·검산에 걸린 것들. 비어 있지 않으면 화면이 "초안 확인 필요"로 표시한다.
      warnings   JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_at BIGINT NOT NULL
    );
  `);

  for (const t of TABLES) {
    pgm.sql(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_${t}_tenant') THEN
          EXECUTE 'ALTER TABLE ${t} ADD CONSTRAINT fk_${t}_tenant
                     FOREIGN KEY (tenant_id) REFERENCES tenants(id)';
        END IF;

        EXECUTE 'CREATE INDEX IF NOT EXISTS idx_${t}_tenant ON ${t}(tenant_id)';

        EXECUTE 'ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY';
        EXECUTE 'ALTER TABLE ${t} FORCE  ROW LEVEL SECURITY';
        EXECUTE 'DROP POLICY IF EXISTS tenant_isolation ON ${t}';
        EXECUTE 'CREATE POLICY tenant_isolation ON ${t}
                   USING ${PREDICATE}
                   WITH CHECK ${PREDICATE}';
      END $$;
    `);
  }

  // 조회는 늘 "내 것을 최근 순으로" 다 — 목록 화면이 그 한 가지 질의만 한다.
  pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_chat_thread_user
      ON chat_thread(tenant_id, user_id, last_message_at DESC);
    CREATE INDEX IF NOT EXISTS idx_chat_message_thread
      ON chat_message(thread_id, created_at ASC);
    CREATE INDEX IF NOT EXISTS idx_report_doc_user
      ON report_doc(tenant_id, user_id, created_at DESC);
  `);
};

// 되돌리면 격리가 사라지는 게 아니라 **표가 통째로 없어진다.** 대화 기록은 사용자 것이라
// 복구가 안 된다 — down 은 개발 중 되감기용이지 운영에서 부를 것이 아니다.
/** @param {MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS chat_message;
    DROP TABLE IF EXISTS report_doc;
    DROP TABLE IF EXISTS chat_thread;
  `);
};
