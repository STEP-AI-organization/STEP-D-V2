# STEP D Admin — 플랫폼 관리 콘솔

`admin.stepd.stepai.kr` · Vite + React SPA · Vercel 독립 배포.

**대상은 우리(운영사)다.** 방송사 운영자가 쓰는 화면은 `apps/web`이고, 여기는 그 위층 —
테넌트를 만들고, 사람을 초대하고, 잡을 들여다보고, 누가 무엇을 열람했는지 확인한다.

> 이 폴더는 원래 **STEP D Lab**(분석 결과 검수 + 숏폼↔롱폼 매칭)이었다. 2026-08-10 사용자
> 결정으로 Lab 을 걷어내고 관리 콘솔로 재정의했다. 서버의 `/api/lab/*` 라우트와 `/lab` 서빙도
> 같이 제거했다. **매칭 학습 파이프라인 자체(`match.align`·`match.segment`·`match.learn` 잡과
> `short_source_map` 테이블)는 남아 있다** — 그 산출물(채널 포인트 프로파일)이 추천에 쓰이기
> 때문이다. 되살리려면 git 이력에서 Lab UI 를 꺼내면 된다.

## 화면

| 탭 | 내용 |
|---|---|
| 개요 | 전 테넌트 합계 — 테넌트·사용자·미디어·분(minute)·잡 상태 |
| 테넌트 | 목록·생성·정지/활성화·초대 발급 |
| 사용자 | 전 테넌트 계정, 정지/활성화 |
| 잡 | job_queue 최근 200건 (테넌트 표시) |
| 감사 로그 | superadmin 이 한 일 — **열람 포함** |

## 권한

전 화면이 `users.role = 'superadmin'` 세션 뒤에 있다. 프런트의 역할 체크는 편의일 뿐이고
**실제 경계는 서버**(`apps/server/src/admin.ts`)다.

- superadmin 은 초대로 만들어지지 않는다. `pnpm --filter @stepd/server user:create --role superadmin` 만이 부여 경로다.
- 남의 테넌트를 열람·변경하는 호출은 **사유(4자 이상)** 없이는 400 이다.
- 감사 기록이 실패하면 요청도 실패한다 — 기록되지 않은 관리자 행위를 성공으로 돌려주지 않는다.

## 개발

```bash
pnpm --filter @stepd/server dev          # :4100
pnpm --filter @stepd/admin  dev          # :4300  (/api/* → :4100 프록시)
```

`/api/*` 는 항상 상대경로로 부른다. 세션이 HttpOnly 쿠키라 **브라우저가 보기에 같은 오리진**
이어야 쿠키가 실린다 — 프로덕션은 `vercel.json` 의 rewrite, 개발은 vite proxy 가 그 역할을 한다.
앱 코드는 API 호스트를 모른다.

로그인하려면 계정이 필요하다(초대제라 첫 사람은 CLI 로 만든다):

```bash
pnpm --filter @stepd/server user:create --email you@stepai.kr --role superadmin
```

## 배포

Vercel 프로젝트를 이 디렉터리에 연결하고 도메인을 `admin.stepd.stepai.kr` 로 지정한다.
`vercel.json` 이 `/api/*` 를 `stepd.stepai.kr/api/proxy/api/*` 로 넘긴다(ID 토큰 프록시 경유).
`public: false` 이며 `index.html` 에 `noindex` 를 넣어 두었다.
