/**
 * 공용 메일 발송 — 인보이스(invoice-email.ts)와 자동배포 완료 알림(worker)이 **같은
 * transport 배선**을 쓴다. 두 벌이 되면 인증 방식(평문/OAuth2)을 바꿀 때 한쪽만 고쳐져
 * 다른 쪽이 조용히 죽는다.
 *
 * 설정 판정은 invoice.ts 의 smtpConfigured/smtpOAuthConfigured(순수 함수) — 여기는 배선만.
 * 인증은 둘 중 하나:
 *   평문   SMTP_HOST · SMTP_PORT(기본 587) · SMTP_USER · SMTP_PASS
 *   OAuth  SMTP_USER + SMTP_OAUTH_CLIENT_ID/SECRET/REFRESH_TOKEN (Gmail XOAUTH2 ·
 *          호스트·포트 생략 시 smtp.gmail.com:465 — 이 인증 방식 자체가 Google 전용이다)
 *
 * ⚠️ 여기서 던질 수 있다 — **호출부가 베스트 에포트를 결정한다.** 인보이스도 알림도
 * "메일 실패가 본 작업(적립·배포)을 되돌리면 안 된다"는 원칙이라 호출부가 전부 삼킨다.
 */
import { smtpConfigured, smtpOAuthConfigured } from "./billing/invoice.ts";

export { smtpConfigured as mailConfigured };

export interface MailMessage {
  to: string;
  subject: string;
  html: string;
  attachments?: { filename: string; content: Buffer; contentType: string }[];
}

export async function sendMail(msg: MailMessage): Promise<void> {
  const nodemailer = await import("nodemailer");
  const oauth = smtpOAuthConfigured();
  const port = Number(process.env.SMTP_PORT ?? (oauth ? 465 : 587));
  const transport = nodemailer.default.createTransport({
    host: String(process.env.SMTP_HOST ?? (oauth ? "smtp.gmail.com" : "")),
    port,
    secure: port === 465,
    auth: oauth
      ? {
          type: "OAuth2",
          user: String(process.env.SMTP_USER),
          clientId: String(process.env.SMTP_OAUTH_CLIENT_ID),
          clientSecret: String(process.env.SMTP_OAUTH_CLIENT_SECRET),
          refreshToken: String(process.env.SMTP_OAUTH_REFRESH_TOKEN),
        }
      : { user: String(process.env.SMTP_USER), pass: String(process.env.SMTP_PASS) },
  });
  await transport.sendMail({
    from: String(process.env.INVOICE_MAIL_FROM ?? process.env.SMTP_USER),
    to: msg.to,
    subject: msg.subject,
    html: msg.html,
    ...(msg.attachments ? { attachments: msg.attachments } : {}),
  });
}
