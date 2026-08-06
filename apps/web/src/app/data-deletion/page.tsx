import { LegalPage } from "@/components/legal-page";

export const metadata = {
  title: "사용자 데이터 삭제 안내 — STEP D",
  description:
    "STEP D 서비스에 연결된 Facebook·Instagram·TikTok·YouTube 계정 데이터를 삭제하는 방법을 안내합니다.",
};

/**
 * Meta App Review requires a "User Data Deletion" URL that publicly explains how a
 * user can request removal of data collected via the app. TikTok and Google likewise
 * accept a documented URL. This page satisfies all three.
 */
export default function DataDeletionPage() {
  return (
    <LegalPage title="사용자 데이터 삭제 안내" updated="2026년 8월 5일">
      <section>
        <p>
          STEP AI(이하 &ldquo;회사&rdquo;)는 콘텐츠 분석·배포 서비스 STEP D(이하 &ldquo;서비스&rdquo;)에서
          이용자가 연결한 Facebook Page, Instagram Business, TikTok, YouTube 계정으로부터 취득한
          토큰과 관련 데이터를 이용자 요청 시 지체 없이 삭제합니다.
        </p>
      </section>

      <section>
        <h2>1. 삭제되는 데이터 범위</h2>
        <ul>
          <li>연결한 플랫폼의 액세스 토큰·리프레시 토큰</li>
          <li>연결한 Facebook Page ID / Instagram Business Account ID / TikTok open_id / YouTube 채널 ID</li>
          <li>해당 계정에서 수집한 프로필(표시명, 사용자명, 프로필 사진 URL)</li>
          <li>회사가 이 계정으로 예약·업로드한 게시물의 배포 상태 기록</li>
        </ul>
      </section>

      <section>
        <h2>2. 앱 안에서 스스로 해제</h2>
        <p>
          로그인 후 <strong>&ldquo;배포채널&rdquo;</strong> 페이지에서 연결된 계정 옆의 &ldquo;삭제&rdquo;
          버튼을 눌러 즉시 해제할 수 있습니다. 삭제 즉시 회사 데이터베이스에서 해당 행이 지워지며,
          이후 서비스는 그 토큰으로 어떠한 요청도 보내지 않습니다.
        </p>
      </section>

      <section>
        <h2>3. 이메일로 삭제 요청</h2>
        <p>
          앱에 접속할 수 없거나 계정을 이미 삭제한 경우, 아래 이메일로 요청하시면 영업일 기준 7일
          이내에 처리하고 결과를 회신드립니다.
        </p>
        <ul>
          <li>
            수신: <a href="mailto:hkj@stepai.kr">hkj@stepai.kr</a>
          </li>
          <li>
            제목: <em>[STEP D] 사용자 데이터 삭제 요청</em>
          </li>
          <li>
            본문에 포함할 정보: 연결에 사용한 플랫폼(Facebook / Instagram / TikTok / YouTube),
            해당 플랫폼에서의 사용자명 또는 페이지 이름
          </li>
        </ul>
      </section>

      <section>
        <h2>4. 각 플랫폼 쪽에서의 앱 권한 회수</h2>
        <p>
          회사 데이터베이스에서 지워도, 이용자 본인 계정의 &ldquo;앱 및 웹사이트&rdquo; 설정에서 STEP D의
          권한을 취소해야 완전한 해제가 됩니다.
        </p>
        <ul>
          <li>
            Facebook / Instagram:{" "}
            <a href="https://www.facebook.com/settings?tab=business_tools" target="_blank" rel="noreferrer">
              페이스북 설정 &gt; 비즈니스 통합
            </a>
          </li>
          <li>
            TikTok:{" "}
            <a
              href="https://www.tiktok.com/setting/apps-and-website"
              target="_blank"
              rel="noreferrer"
            >
              TikTok 설정 &gt; 앱 관리
            </a>
          </li>
          <li>
            Google / YouTube:{" "}
            <a
              href="https://myaccount.google.com/permissions"
              target="_blank"
              rel="noreferrer"
            >
              Google 계정 &gt; 서드파티 앱과 서비스
            </a>
          </li>
        </ul>
      </section>

      <section>
        <h2>5. 보관 예외</h2>
        <p>
          법령(전자상거래법, 통신비밀보호법 등)에 따라 일정 기간 보관이 요구되는 거래·접속 기록은
          해당 기간 동안만 별도 저장 후 파기합니다. 이 경우에도 위 1항의 토큰과 프로필 정보는 즉시
          삭제됩니다.
        </p>
      </section>

      <section>
        <h2>6. 문의</h2>
        <p>
          STEP AI · 대표 이메일{" "}
          <a href="mailto:hkj@stepai.kr">hkj@stepai.kr</a>
        </p>
      </section>
    </LegalPage>
  );
}
