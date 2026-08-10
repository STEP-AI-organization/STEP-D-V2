/* eslint-disable camelcase */
/**
 * 0014 — 테넌트 격리 2단계: Row Level Security 로 DB가 직접 강제
 *
 * 왜 애플리케이션 WHERE 가 아니라 RLS 인가
 *   db-pg.ts 에는 조회 함수가 100개 가까이 있다. 모든 쿼리에 손으로 WHERE 를 붙이는 방식은
 *   **한 군데만 빠뜨려도 유출**이고, 빠뜨렸다는 사실이 타입으로도 테스트로도 드러나지 않는다.
 *   RLS 는 정책이 행 자체를 숨기므로 "쿼리를 잘못 써서" 남의 데이터를 보는 경로가 없다.
 *
 * 어떻게 동작하나
 *   커넥션마다 `set_config('app.tenant_id', <테넌트>, false)` 를 먼저 심는다(db-pg.ts 풀 프록시).
 *   정책은 그 값과 행의 tenant_id 를 비교한다.
 *     · 값이 특정 테넌트  → 그 테넌트 행만
 *     · 값이 '*'          → 전 테넌트 (스케줄러·큐 워커 등 시스템 작업. runAsSystem)
 *     · 값이 없음(NULL)   → **아무 행도 안 보인다.** 배선을 빼먹으면 유출이 아니라 빈 결과가 난다.
 *   실패 방향을 "안 보임"으로 잡은 게 핵심이다 — upload-gate.ts 와 같은 사고방식.
 *
 * ⚠️ FORCE ROW LEVEL SECURITY 가 필수다
 *   ENABLE 만 하면 **테이블 소유자는 정책을 우회한다.** 우리 앱은 보통 소유자 역할로 접속하므로
 *   ENABLE 만으로는 아무것도 막히지 않는다. FORCE 를 걸어야 소유자에게도 적용된다.
 *   (BYPASSRLS 속성을 가진 역할·슈퍼유저는 FORCE 로도 못 막는다 → db-pg.ts 가 기동 시 점검한다.)
 *
 * tenant_id DEFAULT 도 바꾼다
 *   0013 의 DEFAULT 't_default' → `current_setting('app.tenant_id', true)`.
 *   tenant_id 를 명시하지 않는 기존 INSERT 가 **현재 컨텍스트의 테넌트로** 들어간다.
 *   시스템 스코프('*')에서 tenant_id 없이 INSERT 하면 FK 위반으로 시끄럽게 실패한다 — 의도한 바다.
 *   (그런 INSERT 는 어느 테넌트 것인지 코드가 모른다는 뜻이므로 조용히 넘어가면 안 된다.)
 *
 * tenants 테이블 자체는 RLS 대상이 아니다 — 고객 콘텐츠가 없고, 테넌트 해석(요청 → 테넌트)이
 * 컨텍스트가 정해지기 *전에* 이 테이블을 읽어야 하기 때문이다.
 */

const TABLES = [
  "entities", "media", "kv", "job_queue",
  "youtube_channels", "meta_accounts", "tiktok_accounts", "search_events",
  "content_analysis", "transcript", "search_segments", "episode_cast",
  "program_cast",
  "channel_videos", "channel_analytics", "video_stats", "video_analytics",
  "video_retention", "video_comments", "short_source_map",
  "rights_issue", "rights_judgement", "gate_audit",
];

// EXECUTE 안의 문자열 리터럴로 들어가므로 작은따옴표를 두 번 쓴다.
// (한 번만 쓰면 EXECUTE 문자열이 거기서 끊겨 "syntax error at or near ." 로 죽는다.)
const PREDICATE = `(tenant_id = current_setting(''app.tenant_id'', true)`
  + ` OR current_setting(''app.tenant_id'', true) = ''*'')`;

exports.up = async (pgm) => {
  for (const t of TABLES) {
    pgm.sql(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM information_schema.tables
                   WHERE table_schema = current_schema() AND table_name = '${t}') THEN
          EXECUTE 'ALTER TABLE ${t} ALTER COLUMN tenant_id SET DEFAULT current_setting(''app.tenant_id'', true)';
          EXECUTE 'ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY';
          EXECUTE 'ALTER TABLE ${t} FORCE  ROW LEVEL SECURITY';
          EXECUTE 'DROP POLICY IF EXISTS tenant_isolation ON ${t}';
          EXECUTE 'CREATE POLICY tenant_isolation ON ${t}
                     USING ${PREDICATE}
                     WITH CHECK ${PREDICATE}';
        END IF;
      END $$;
    `);
  }
};

// 되돌리면 격리가 사라진다.
exports.down = false;
