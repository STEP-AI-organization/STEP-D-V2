import { NextRequest, NextResponse } from "next/server";
import { getIdToken } from "@/lib/gcp-auth";

export const runtime = "nodejs";

const CLOUD_RUN_URL = (process.env.CLOUD_RUN_URL || "https://stepd-server-872105344568.us-central1.run.app").replace(/\/$/, "");

export async function GET(request: NextRequest, { params }: { params: Promise<{ path?: string[] }> }) {
  return proxy(request, params);
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ path?: string[] }> }) {
  return proxy(request, params);
}

export async function PUT(request: NextRequest, { params }: { params: Promise<{ path?: string[] }> }) {
  return proxy(request, params);
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ path?: string[] }> }) {
  return proxy(request, params);
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ path?: string[] }> }) {
  return proxy(request, params);
}

async function proxy(request: NextRequest, paramsPromise: Promise<{ path?: string[] }>) {
  const { path } = await paramsPromise;
  const upstreamPath = path ? `/${path.join("/")}` : "";
  const upstreamUrl = `${CLOUD_RUN_URL}${upstreamPath}${request.nextUrl.search}`;

  try {
    const token = await getIdToken();
    const headers = new Headers(request.headers);
    headers.delete("host");
    // 본문을 버퍼로 다시 보내므로 원본 길이 헤더는 버린다 — 안 맞으면 업스트림이 끊는다.
    headers.delete("content-length");
    headers.set("Authorization", token);

    const body = request.body ? await request.arrayBuffer() : undefined;

    const upstreamRes = await fetch(upstreamUrl, {
      method: request.method,
      headers,
      body,
      redirect: "manual",
    });

    const resHeaders = new Headers(upstreamRes.headers);
    // fetch 가 이미 압축을 풀었으므로 둘 다 지운다. content-length 를 남기면
    // 압축 크기가 그대로 실려 응답이 잘린다.
    resHeaders.delete("content-encoding");
    resHeaders.delete("content-length");

    return new NextResponse(upstreamRes.body, {
      status: upstreamRes.status,
      statusText: upstreamRes.statusText,
      headers: resHeaders,
    });
  } catch (e) {
    // 예외를 그대로 두면 **빈 500** 이 나가서 원인을 알 수 없다. 실제로 그것 때문에
    // "간헐적으로 로그인이 안 된다"를 한참 헤맸다(2026-08-11). 사유를 실어 보낸다.
    const message = e instanceof Error ? e.message : String(e);
    console.error(`[proxy] ${request.method} ${upstreamPath} 실패:`, e);
    return NextResponse.json(
      { error: "proxy_failed", message, path: upstreamPath },
      { status: 502 },
    );
  }
}
