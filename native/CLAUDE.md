# native/ — STEPAISTUDIO 데스크톱 셸 (Electron · Windows)

**웹을 감싸는 껍데기가 아니라, 웹이 못 하는 일만 하는 얇은 층이다.** 화면은 전부
프로덕션 웹(`https://stepd.stepai.kr`)이고, 이 앱은 브라우저에 없는 능력만 얹는다.

---

## 한 줄 규칙 — 무엇을 고치면 무엇을 배포하나

| 고친 곳 | 배포 | 편집자가 할 일 |
|---|---|---|
| `apps/web/**` | **웹만** (Vercel) | **없다.** 앱을 다시 켜면 새 화면이다 |
| `native/**` | 웹 + **버전 올려 발행** | **없다.** 앱이 알아서 받아 재시작한다 |

**자동 업데이트가 있다 (2026-09-07~).** `pnpm --filter stepaistudio dist` 로 굽고
`publish:update -- --yes` 로 발행하면, 편집자 PC 는 최대 6시간 안에 받아 두고 **노는 순간**
스스로 재시작한다. 그 전까지는 고칠 때마다 PC 를 돌아야 했다.

그래도 **경계는 그대로 지킨다.** 자동이라도 웹보다 느리고(6시간 · 재시작 필요), 되돌릴
방법이 다음 버전을 급히 올리는 것뿐이다. 웹으로 할 수 있는 일은 웹에.

### 발행 — 올리는 순간 전 PC 가 받는다

```bash
# native/package.json 의 version 을 올린 뒤
pnpm --filter stepaistudio dist                      # release/ 에 exe + latest.yml
pnpm --filter stepaistudio publish:update            # 무엇이 올라갈지 보여주고 멈춘다
pnpm --filter stepaistudio publish:update -- --yes   # 실제 발행
```

발행 스크립트가 하는 일은 대부분 **안 올리는 것**이다 — 프리릴리스(`0.3.0-beta.1`),
되돌리기·같은 버전 재발행, **버전만 올리고 다시 안 빌드한 경우**(`latest.yml` 의 버전과
`package.json` 이 다르면 거절)를 막는다. 마지막 것이 실전에서 제일 자주 걸린다.

⚠️ **같은 버전 번호로 내용을 바꾸지 말 것.** 편집자 PC 는 번호로만 판단하므로 이미 받은
PC 는 영영 안 받는다.

### 언제 갈아끼우나 — `src/update/policy.ts`

설치는 앱을 종료시킨다. 그래서 판정을 순수 함수로 빼 뒀다(테스트로 고정):

| 상태 | 자동 | 사용자가 "지금 재시작" |
|---|---|---|
| 노는 중 | 깐다 | 깐다 |
| 전송 중 | 기다린다 | **깐다** — 큐가 영속이라 이어받는다 |
| **굽는 중** | 기다린다 | **안 깐다** — 이어받을 수 없다. 끝나면 자동으로 |

못 깔 때는 사유를 화면에 남긴다. 아무 일도 안 일어나면 버튼이 고장 난 것처럼 보인다.

**피드는 `/api/desktop/*`** — 비공개 GCS 객체 + 서명 URL 302 (`/api/naver/login-tool` 과
같은 구조). 두 버킷 다 공개 객체 금지라 공개 버킷을 새로 파지 않았고, 302 라 **설치본
바이트가 Cloud Run 을 안 지난다**(100MB 를 서버로 흘리면 그게 egress 청구서다).

---

## 경계 — 네이티브에만 있어야 하는 것

브라우저가 **원리적으로 못 하는 것**만 여기 둔다. 판단 기준은 "탭을 닫아도 되어야 하나 ·
로컬 파일 경로가 필요한가 · OS 에 등록해야 하나" 셋이다.

| 능력 | 왜 네이티브여야 하나 | 파일 |
|---|---|---|
| 영속 업로드 큐 | 창을 닫아도, 앱을 껐다 켜도 이어받는다. 브라우저 탭은 닫히면 끝 | `transfer/engine.ts` · `transfer/job-store.ts` |
| 로컬 파일 경로 | `webUtils.getPathForFile` — 브라우저는 실제 경로를 안 준다(몇 GB 를 메모리에 안 올리고 부분 읽기하려면 필요) | `preload.ts` |
| GCS resumable 청크 | 308 이어받기·오프셋 되묻기. XHR 로도 되지만 **탭 생존에 묶인다** | `transfer/engine.ts` · `transfer/network.ts` |
| 트레이 상주 | 창을 닫아도 전송이 계속되고, 끝나면 알아서 종료 | `main.ts` |
| `stepd://` 프로토콜 | OS 가 브라우저→앱으로 넘기는 문. 웹에서 만들 수 없다 | `main.ts` |
| 프리미어 실행 | `openPremiere()` — 설치 경로를 훑어 spawn. 브라우저는 프로세스를 못 띄운다 | `main.ts` |

**나머지는 전부 웹이다.** 화면·업무 로직·API 호출·권한·문구 — 여기 넣지 말 것.

### 폴더 (2026-09-02 정리 · 15개가 평평하던 것을 묶었다)

```
src/
  main.ts        메인 프로세스 — 창·트레이·프로토콜·IPC
  preload.ts     렌더러 브리지 — 신뢰 origin 에서만 노출
  contract.ts    ⭐ 웹과의 계약. **여기만 웹과 맞물린다** (아래 참조)
  transfer/      업로드 스택 — 브라우저가 못 하는 일의 본체
    engine.ts            전송 엔진(청크·재개·재시도·finalize)
    network.ts           포트 — TransferNetwork 인터페이스 + 308 오프셋 해석
    network-electron.ts  어댑터 — Electron net 구현
    job-store.ts         작업 영속화(앱을 껐다 켜도 이어받는 근거)
    fingerprint.ts       같은 크기로 바꿔치기된 파일 탐지
    mime.ts · errors.ts · validation.ts
  tests/         *.test.ts (apps/server/src/tests 와 같은 규칙)
```

⚠️ **최상위 셋은 자리를 지킨다.** `main.ts`·`preload.ts`·`contract.ts` 는 esbuild
**진입점**이고(`scripts/build.mjs`) 출력이 `dist/main.cjs`·`dist/preload.cjs` 로 나가는데,
`package.json` 의 `main` 과 `main.ts` 의 `path.join(__dirname, "preload.cjs")` 가 그 경로를
가리킨다. 옮기려면 빌드 스크립트와 그 둘을 같이 고쳐야 한다. 나머지는 번들되므로 자유롭다.

`network.ts`(포트) / `network-electron.ts`(어댑터) 이름이 갈린 이유는 **테스트가 가짜
네트워크를 끼워 넣기 때문**이다 — 전송 엔진 테스트가 실제 GCS 없이 308 재개를 검증한다.

---

## 결합 지점은 **하나**다 — `contract.ts`

웹과 네이티브가 만나는 면은 `window.stepdNative` 뿐이고, 그 모양이 `contract.ts` 다.

```ts
interface StepdNativeBridge {
  readonly version: 1;          // ← 이 숫자가 배포 결합의 전부다
  enqueueUpload(file, request): Promise<{ jobId }>;
  listUploads() · pauseUpload() · resumeUpload() · cancelUpload()
  retryUpload() · relinkUpload() · clearCompleted() · subscribeUploads()
}
```

웹은 이렇게 방어한다 (`apps/web/src/lib/native-transfers.tsx`):

```ts
if (!bridge || bridge.version !== 1) return;   // → available=false → 브라우저 업로드로 폴백
```

그래서 **버전이 어긋나도 안 깨진다 — 대신 네이티브 이점이 조용히 사라진다.** 편집자는
"평소보다 업로드가 느리고 창을 닫으면 끊긴다" 로만 느낀다. 그게 이 구조의 가장 조용한 실패다.

### 그래서 규칙

- **계약을 안 건드리는 웹 변경** → 웹만 배포. 앱은 그대로 둔다. (대부분이 여기다)
- **계약에 메서드를 추가** → 앱을 먼저 깔고, 그 다음 웹에서 쓴다. 순서를 뒤집으면 아직 안
  깐 PC 에서 `bridge.newMethod is not a function` 이 난다(버전 가드는 **모양**이 아니라
  **숫자**만 본다 — 추가는 가드를 통과해 버린다).
- **`version` 을 올린다** → 앱을 안 깐 PC 는 전부 브라우저 업로드로 떨어진다. 올릴 값이
  있을 때만 올리고, 올렸으면 **자동 업데이트가 전 PC 에 도는 동안**(최대 6시간 + 재시작)
  네이티브 이점이 없다고 봐야 한다. 예전엔 이게 "사람이 다 돌 때까지" 였다.

---

## 왜 웹을 원격으로 로드하나

`main.ts` 는 프로덕션 URL 을 그대로 띄운다. 화면을 앱 안에 번들하지 않는 이유:

- **웹 배포가 곧 앱 갱신**이다. 화면을 고칠 때마다 편집자 PC 를 돌지 않아도 된다
- 웹과 앱의 화면이 갈라질 수 없다 — 같은 것을 보므로
- 대가: 앱은 **오프라인에서 못 쓴다.** 업로드 큐는 로컬에 남지만 화면이 안 뜬다

`guardNavigation` 이 `trustedOrigin()` 밖으로의 이동을 막는다 — 원격 로드의 대가로
치르는 방어다. `preload.ts` 도 `origin` 을 확인하고서야 브리지를 노출한다(신뢰하지 않는
페이지가 열려도 네이티브 능력이 새지 않게).

---

## 빌드·배포

```bash
pnpm --filter stepaistudio build     # TS → dist/*.cjs
pnpm --filter stepaistudio dist      # electron-builder → release/STEPAISTUDIO-Setup-<ver>.exe
pnpm --filter stepaistudio test      # 계약·전송엔진 단위 테스트
```

- NSIS `oneClick: true` · `perMachine: false` → **사용자 폴더에 설치**(관리자 권한 불필요).
  실제 경로는 `%LOCALAPPDATA%\Programs\stepaistudio\STEPAISTUDIO.exe` — 폴더 이름은 **패키지명**에서
  나온다(`package.json` 의 `name`). 2026-09-07 개명 전에는 `@stepdnative` 였다.
  **자동 업데이트의 전제이기도 하다** — 관리자 설치면 갱신마다 UAC 가 떠서 무인 설치가 멈춘다.
- 버전은 `native/package.json` 의 `version`. 올리면 설치 파일 이름도 따라 바뀐다.
- `pnpm --filter stepaistudio publish:update` — 발행(위 "발행" 절). **`--yes` 없이는 안 올린다.**

---

## 함정

- **URL 스킴 주인은 하나다.** 앱은 `stepaistudio://`(정본)와 `stepd://`(하위호환) 둘 다 등록한다. 이 앱이 설치되면 스킴을 가져간다(`setAsDefaultProtocolClient`).
  `packages/premiere/launcher/install.ps1` 을 같은 PC 에서 돌리면 덮어써서 앱 딥링크
  (`stepaistudio://app/...`)가 죽는다. 앱이 이미 `stepd://open` 으로 프리미어를 띄우므로 런처는
  **앱을 안 쓰는 PC** 전용이다.
- **창 닫기는 종료가 아니다.** 미완료 전송이 있으면 숨기고 계속한다(`closeWhenIdle`).
  창을 다시 열면 그 예약을 **반드시** 푼다 — 안 그러면 사용자가 메타데이터를 입력하는
  도중 마지막 업로드가 끝나며 앱이 통째로 꺼진다.
- **설치본이 최신인지 확인**할 땐 `native/release/*.exe` 의 빌드 시각과 `native/src` 의
  mtime 을 비교한다. 커밋 시각이 아니라 **파일 시각**이 기준이다.
