/**
 * 네이버 최초 1회 수동 로그인 — 워커 PC 에서 사람이 실행한다.
 *
 *   pnpm --filter @stepd/server naver:login
 *
 * 브라우저가 뜨면 아이디/비번/2차인증을 **사람이** 넣는다. 코드는 자격증명을 만지지 않는다.
 * 끝나면 storageState 가 ~/.stepd/naver-storage-state.json 에 저장되고, 워커가 그걸 쓴다.
 * 세션이 만료되면(잡이 NaverSessionExpiredError 로 실패) 이걸 다시 돌리면 된다.
 */
import { interactiveNaverLogin } from "../src/naver/naver-tv.ts";
import { naverSessionPath } from "../src/naver/naver-session.ts";

// 고객사가 여럿이면 계정마다 세션이 따로다:
//   pnpm --filter @stepd/server naver:login --account <accountKey>
// accountKey 는 우리가 발급한 불투명 키다(네이버 아이디가 아니다).
const i = process.argv.indexOf("--account");
const accountKey = i >= 0 ? process.argv[i + 1] : undefined;
if (i >= 0 && !accountKey) { console.error("--account 뒤에 키가 필요하다"); process.exit(1); }

await interactiveNaverLogin(5 * 60_000, accountKey);
console.log(`계정: ${accountKey ?? "(레거시 단일 세션)"}`);
console.log(`저장 위치: ${naverSessionPath(accountKey)}`);
console.log("⚠️ 이 파일은 로그인 쿠키다. 커밋·복사·전송 금지.");
process.exit(0);
