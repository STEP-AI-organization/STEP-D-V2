import { LegalPage } from "@/components/legal-page";

export const metadata = {
  title: "개인정보처리방침 — STEP D",
  description: "STEP D가 YouTube 채널 데이터를 어떻게 수집·이용·보관하는지 설명합니다.",
};

export default function PrivacyPage() {
  return (
    <LegalPage title="개인정보처리방침" updated="2026년 7월 14일">
      <section>
        <p>
          STEP AI(이하 &ldquo;회사&rdquo;)는 콘텐츠 분석 서비스 STEP D(이하 &ldquo;서비스&rdquo;)를 운영합니다.
          본 방침은 이용자가 자신의 YouTube 채널을 서비스에 연결할 때 회사가 어떤 데이터를
          수집하고, 무엇에 쓰며, 어떻게 보관·삭제하는지 설명합니다.
        </p>
      </section>

      <section>
        <h2>1. 수집하는 정보</h2>
        <p>
          이용자가 Google 계정으로 채널을 연결하면, 회사는 이용자가 동의한 범위에서
          YouTube API를 통해 다음 데이터에 접근합니다.
        </p>
        <ul>
          <li><strong>채널 기본 정보</strong> — 채널 ID, 채널명, 채널 썸네일, 구독자 수</li>
          <li><strong>영상 정보</strong> — 영상 ID, 제목, 설명, 게시일, 길이, 썸네일</li>
          <li><strong>공개 지표</strong> — 조회수, 좋아요 수, 댓글 수</li>
          <li>
            <strong>채널 분석 지표</strong> — 시청 시간, 평균 시청 지속시간, 평균 시청률,
            구독자 증감, 트래픽 유입 경로, 시청자 인구통계(연령·성별 등 집계값)
          </li>
          <li>
            <strong>인증 토큰</strong> — Google이 발급한 액세스 토큰 및 갱신(refresh) 토큰.
            이용자를 대신해 위 데이터를 주기적으로 조회하기 위해 보관합니다.
          </li>
        </ul>
        <p>
          회사는 <strong>이용자의 Google 계정 비밀번호를 받지도, 보관하지도 않습니다.</strong>
          인증은 전적으로 Google의 OAuth 2.0 화면에서 이루어집니다.
        </p>
      </section>

      <section>
        <h2>2. 요청하는 권한(스코프)</h2>
        <p>서비스는 채널 분석에 필요한 <strong>읽기 전용</strong> 권한만 요청합니다.</p>
        <ul>
          <li>
            <code>youtube.readonly</code> — 채널 및 영상의 메타데이터 조회
          </li>
          <li>
            <code>yt-analytics.readonly</code> — 채널 분석 지표 조회
          </li>
        </ul>
        <p>
          서비스는 이용자의 영상을 <strong>업로드·수정·삭제할 수 없으며</strong>, 채널에 어떤 변경도
          가하지 않습니다. 해당 권한을 요청하지 않기 때문입니다.
        </p>
      </section>

      <section>
        <h2>3. 이용 목적</h2>
        <ul>
          <li>연결된 채널의 성과 분석 리포트 생성</li>
          <li>영상별 성과 비교 및 콘텐츠 추천</li>
          <li>지표의 시계열 추적을 위한 주기적 동기화</li>
        </ul>
        <p>
          회사는 수집한 데이터를 <strong>광고 목적으로 이용하지 않으며, 판매하지 않습니다.</strong>
          또한 이 데이터를 사람이 열람하는 경우는 이용자의 명시적 동의가 있거나, 보안 사고
          대응·법령 준수를 위해 필요한 경우로 한정됩니다.
        </p>
      </section>

      <section>
        <h2>4. Google 사용자 데이터 정책 준수 (Limited Use)</h2>
        <p>
          STEP D가 Google API로부터 받은 정보의 이용 및 다른 앱으로의 전송은, 제한적 사용(Limited Use)
          요건을 포함한{" "}
          <a
            href="https://developers.google.com/terms/api-services-user-data-policy"
            target="_blank"
            rel="noreferrer"
          >
            Google API 서비스 사용자 데이터 정책
          </a>
          을 준수합니다.
        </p>
        <p className="text-sm text-zinc-500">
          STEP D&rsquo;s use and transfer of information received from Google APIs to any other app
          will adhere to the{" "}
          <a
            href="https://developers.google.com/terms/api-services-user-data-policy"
            target="_blank"
            rel="noreferrer"
          >
            Google API Services User Data Policy
          </a>
          , including the Limited Use requirements.
        </p>
      </section>

      <section>
        <h2>5. 제3자 제공</h2>
        <p>
          회사는 이용자의 YouTube 데이터를 제3자에게 제공하거나 판매하지 않습니다. 다만 서비스
          운영에 필요한 범위에서 아래 인프라 제공자를 이용하며, 이들은 회사의 지시에 따라 데이터를
          처리합니다.
        </p>
        <ul>
          <li>Google Cloud Platform — 서버 및 데이터베이스 운영</li>
          <li>Vercel — 웹 프론트엔드 호스팅</li>
        </ul>
      </section>

      <section>
        <h2>6. 보관 및 보호</h2>
        <ul>
          <li>데이터는 접근이 통제된 데이터베이스에 저장되며, 전송 구간은 TLS로 암호화됩니다.</li>
          <li>인증 토큰은 서버에만 보관되며 브라우저에 노출되지 않습니다.</li>
          <li>이용자가 연결을 해제하면 해당 채널의 토큰과 수집 데이터를 삭제합니다.</li>
        </ul>
      </section>

      <section>
        <h2>7. 이용자의 권리 — 연결 해제 및 삭제</h2>
        <p>이용자는 언제든지 다음 방법으로 접근 권한을 철회할 수 있습니다.</p>
        <ul>
          <li>
            <a href="https://myaccount.google.com/permissions" target="_blank" rel="noreferrer">
              Google 계정 권한 관리
            </a>{" "}
            페이지에서 STEP D의 접근 권한을 직접 해제
          </li>
          <li>
            <a href="mailto:hkj@stepai.kr">hkj@stepai.kr</a> 로 삭제를 요청 — 확인 후 해당 채널의
            토큰 및 수집 데이터를 지체 없이 삭제합니다.
          </li>
        </ul>
        <p>
          권한이 철회되면 회사는 더 이상 해당 채널의 데이터를 조회할 수 없으며, 보관 중인 토큰은
          무효화됩니다.
        </p>
      </section>

      <section>
        <h2>8. 다른 플랫폼 연동 — Meta(Facebook / Instagram) 및 TikTok</h2>
        <p>
          이용자가 Facebook Page, Instagram Business, 또는 TikTok 계정을 연결한 경우, 회사는 다음 데이터에
          접근합니다.
        </p>
        <ul>
          <li>
            <strong>Meta</strong> — 이용자가 관리하는 Facebook Page 목록·프로필, 각 Page에 연결된 Instagram
            Business 계정의 사용자명·프로필 사진, 그리고 이용자가 앱 안에서 명시적으로 승인한 콘텐츠의 게시.
          </li>
          <li>
            <strong>TikTok</strong> — 계정의 open_id, 표시명, 사용자명, 프로필 사진, 그리고 이용자가 앱 안에서
            명시적으로 승인한 콘텐츠의 업로드.
          </li>
        </ul>
        <p>
          두 플랫폼 모두 액세스 토큰과 위 프로필 정보만 서버에 보관합니다. 이용자의 게시물 콘텐츠 자체(원본
          업로드)는 회사가 제3자에게 공유하지 않으며, 자세한 삭제 절차는{" "}
          <a href="/data-deletion">사용자 데이터 삭제 안내</a> 페이지를 참고하십시오.
        </p>
      </section>

      <section>
        <h2>9. 문의</h2>
        <p>
          본 방침에 관한 문의는 <a href="mailto:hkj@stepai.kr">hkj@stepai.kr</a> 로 연락해 주십시오.
        </p>
      </section>
    </LegalPage>
  );
}
