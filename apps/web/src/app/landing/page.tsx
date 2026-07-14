"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import "./landing.css";

/** 콘솔(현재 우리 서비스) 경로. '들어가기' 버튼이 이리로 이동한다. */
const APP_URL = "/register";

/** 소개영상 URL. API가 비공개 GCS 객체를 읽어 같은 출처로 스트리밍한다. */
const LANDING_VIDEO_URL =
  "/api/landing/video";

// 천 단위 콤마 (SSR/CSR 동일 결과 보장용 — toLocaleString 하이드레이션 불일치 회피)
const comma = (n: number) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
const fmt = (man: number) =>
  man >= 10000 ? (man / 10000).toFixed(man >= 100000 ? 0 : 1) + "억" : comma(man) + "만";

export default function LandingPage() {
  // 수익 계산기 입력값
  const [cust, setCust] = useState(50); // 방송사 고객사 수
  const [arpu, setArpu] = useState(700); // 고객당 월 사용료(만원)
  const [bc, setBc] = useState(5000); // B2C 계정 수
  const [bp, setBp] = useState(4); // B2C 월 요금(만원)
  const [glb, setGlb] = useState(0); // 해외 방송사·파트너 수
  const [gp, setGp] = useState(600); // 해외 월 사용료(만원)

  const calc = useMemo(() => {
    const revB = cust * arpu * 12;
    const mB = 0.3 + ((arpu - 300) / 600) * 0.2;
    const revC = bc * bp * 12;
    const mC = 0.45;
    const revG = glb * gp * 12;
    const mG = 0.25 + ((gp - 200) / 700) * 0.2;
    const rev = revB + revC + revG;
    const pro = revB * mB + revC * mC + revG * mG;
    const cost = rev - pro;
    const setup = (cust + glb) * 3000;
    return {
      rev: fmt(rev),
      cost: fmt(cost),
      pro: fmt(pro),
      mar: (rev > 0 ? Math.round((pro / rev) * 100) : 0) + "%",
      setup: fmt(setup),
      setN: comma(cust + glb),
    };
  }, [cust, arpu, bc, bp, glb, gp]);

  return (
    <div className="stepd-landing">
      {/* NAV */}
      <nav>
        <div className="wrap nav-in">
          <div className="logo">
            <span className="mark">D</span>STEP D
          </div>
          <div className="nav-links">
            <a href="#problem">문제</a>
            <a href="#workspace">워크스페이스</a>
            <a href="#features">기능</a>
            <a href="#market">시장</a>
            <a href="#calc">수익</a>
            <Link href={APP_URL} className="btn btn-p" style={{ padding: "10px 20px" }}>
              들어가기
            </Link>
          </div>
        </div>
      </nav>

      {/* HERO */}
      <header className="hero">
        <div className="wrap">
          <span className="tag">KT ENA 방송 현장에서 운영 중</span>
          <h1>
            콘텐츠를 자산으로,
            <br />
            <span className="grad-txt">자산을 수익으로</span>
          </h1>
          <p className="sub">
            방송이 끝난 영상을 STEP D가 분석해, 잘 될 장면만 골라 <span style={{ whiteSpace: "nowrap" }}>하이라이트·쇼츠·클립</span>으로 만들고,<br />모든 채널에 유통해 <span style={{ whiteSpace: "nowrap" }}>광고(조회수)</span>와 커머스로 수익까지.<br />콘텐츠가 돈이 되는 미디어 운영 서비스입니다.
          </p>
          <div className="cta">
            <Link href={APP_URL} className="btn btn-p">
              들어가기 →
            </Link>
            <a href="#how" className="btn btn-g">
              서비스 둘러보기
            </a>
          </div>

          <div className="mock">
            <div className="bar">
              <span className="dot" style={{ background: "#FF5F57" }}></span>
              <span className="dot" style={{ background: "#FEBC2E" }}></span>
              <span className="dot" style={{ background: "#28C840" }}></span>
              <span style={{ marginLeft: 12, fontSize: 12, color: "var(--mut2)" }}>
                AENA ㆍ KT ENA 실제 운영 화면
              </span>
            </div>
            <div className="mock-body" style={{ padding: 0, display: "block" }}>
              <video
                controls
                playsInline
                preload="metadata"
                style={{ width: "100%", display: "block", borderRadius: "0 0 12px 12px", background: "#000" }}
                src={LANDING_VIDEO_URL}
              >
                브라우저가 영상을 지원하지 않습니다.
              </video>
            </div>
          </div>
        </div>
      </header>

      {/* TRUST STRIP */}
      <section className="trust">
        <div className="wrap">
          <div className="stat">
            <div className="n grad-txt">53%↓</div>
            <div className="l">제작 리드타임 단축 (17H→8H)</div>
          </div>
          <div className="stat">
            <div className="n grad-txt">1,863+</div>
            <div className="l">방송 현장 누적 생성 클립</div>
          </div>
          <div className="stat">
            <div className="n grad-txt">5~9x</div>
            <div className="l">외부 큐레이션 대비 조회수</div>
          </div>
          <div className="stat">
            <div className="n grad-txt">5</div>
            <div className="l">방송·MCN·해외 협약 (KT ENA 운영 중)</div>
          </div>
        </div>
      </section>

      {/* WHY THIS BUSINESS */}
      <section
        className="sec center"
        style={{ background: "var(--bg2)", borderTop: "1px solid var(--line)", borderBottom: "1px solid var(--line)" }}
      >
        <div className="wrap">
          <span className="tag">왜 이 사업인가</span>
          <h2 style={{ marginTop: 18 }}>
            AI 서비스는 많습니다.
            <br />
            <span className="grad-txt">살아남는 AI 서비스는 심플합니다.</span>
          </h2>
          <p className="lead" style={{ maxWidth: 780, marginLeft: "auto", marginRight: "auto" }}>
            대부분은 빅테크 API 위에서 돌아가고, 신기해 보여도 사람들은 &apos;AI라서&apos; 돈을 오래 내지 않아요. 살아남는 건 가치가 명확한 서비스뿐입니다.
          </p>
          <p style={{ maxWidth: 760, margin: "22px auto 0", fontSize: 19, fontStyle: "italic", fontWeight: 600, color: "#1B1B2F", lineHeight: 1.65 }}>
            &quot;신기함은 팔리지 않습니다. 돈 되는 것만 팔립니다. 비용을 줄이고(운영 효율), 매출을 늘린다(생산성). 그 답을 실제 방송사 KT ENA에서 찾았습니다.&quot;
          </p>
        </div>
      </section>

      {/* PROBLEM */}
      <section className="sec center" id="problem">
        <div className="wrap">
          <span className="tag">왜 STEP D 인가</span>
          <h2 style={{ marginTop: 18 }}>
            방송사 수익성은 무너지는데,
            <br />
            운영은 여전히 수작업입니다
          </h2>
          <p className="lead">광고는 빠지고 적자는 쌓이는데, 재가공·운영·수익화는 여전히 사람 손에 묶여 있습니다.</p>
          <div className="cards3" style={{ textAlign: "left" }}>
            <div className="pcard">
              <div className="ic">₩↑</div>
              <h3>운영은 여전히 고비용</h3>
              <p>디지털 재가공·운영(클립·쇼츠·썸네일)이 대부분 사람 손에 묶여 있습니다. 매출은 빠지는데 인건비 구조는 그대로입니다.</p>
            </div>
            <div className="pcard">
              <div className="ic">9.9%↓</div>
              <h3>광고 급감, 방송사 적자</h3>
              <p>지상파 광고매출 8,354억(전년 대비 9.9%↓). 지상파는 2년 연속 영업손실로, KBS 881억·SBS 259억 적자입니다. (방통위 2024)</p>
            </div>
            <div className="pcard">
              <div className="ic">✕</div>
              <h3>분절된 밸류체인</h3>
              <p>기획·제작·편집·유통·수익화가 따로 노는 개별 도구. 데이터가 단절돼 반복 비효율과 품질 저하가 쌓입니다.</p>
            </div>
          </div>
        </div>
      </section>

      {/* SOLUTION / PIPELINE */}
      <section
        className="sec"
        style={{ background: "var(--bg2)", borderTop: "1px solid var(--line)", borderBottom: "1px solid var(--line)" }}
      >
        <div className="wrap center">
          <span className="tag">솔루션</span>
          <h2 style={{ marginTop: 18 }}>
            &lsquo;<span className="grad-txt">콘텐츠 공장</span>&rsquo;을 만듭니다
          </h2>
          <p className="lead">
            콘텐츠는 한 번 쓰고 끝이 아니라, 계속 돈을 버는 자산입니다. 단, 자산이 되려면 상품성이 있어야 하죠. STEP D는 흩어진 제작·편집·유통·수익화를 하나로 모아, 원본을 &lsquo;잘 팔리는 결과물&rsquo;로 만들고 광고는 물론 커머스(제휴 판매)로 수익까지 연결합니다.
          </p>
        </div>
        <div className="wrap" id="how">
          <div className="pipe">
            <div className="step">
              <div className="num">1</div>
              <h4>영상 원본 수집</h4>
              <p>
                방송 프로그램·회차
                <br />
                MXF 소스·자동 인코딩
              </p>
            </div>
            <div className="step">
              <div className="num">2</div>
              <h4>AI가 영상을 이해</h4>
              <p>
                자체 엔진이
                <br />
                장면·하이라이트 파악
              </p>
            </div>
            <div className="step">
              <div className="num">3</div>
              <h4>클립·쇼츠 생성</h4>
              <p>
                한국어·방송에 맞춰
                <br />
                썸네일·자막 자동
              </p>
            </div>
            <div className="step k">
              <div className="num">4</div>
              <h4>이해 기반 선별</h4>
              <p>
                시청자가 왜 좋아했는지 학습
                <br />
                쓸수록 정확해짐
              </p>
            </div>
            <div className="step">
              <div className="num">5</div>
              <h4>멀티채널 배포</h4>
              <p>
                SMR·YouTube·Meta
                <br />
                배포 스케줄링
              </p>
            </div>
            <div className="step">
              <div className="num">6</div>
              <h4>수익화</h4>
              <p>
                광고·PPL 수익화
                <br />
                커머스 제휴 판매
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* WORKSPACE */}
      <section className="sec" id="workspace">
        <div className="wrap">
          <div className="center">
            <span className="tag">팀 워크스페이스</span>
            <h2 style={{ marginTop: 18 }}>
              도구가 아니라,
              <br />
              팀이 매일 출근하는 <span className="grad-txt">워크스페이스</span>
            </h2>
            <p className="lead">
              기획·제작·편집·유통·마케팅 등 미디어 기업의 모든 부서가 한 공간에서 협업하고, 회사의 모든 영상 운영이 STEP D 안에서 돌아갑니다. <b>즉, 우리는 미디어 기업을 재정의합니다.</b>
            </p>
          </div>
          <div className="deptrow">
            <div className="dept">
              <div className="di">기획</div>
              <div className="dn">기획·편성팀</div>
              <div className="dd">프로그램·회차 등록, 클립 전략 수립</div>
            </div>
            <div className="dept">
              <div className="di">제작</div>
              <div className="dn">제작·PD팀</div>
              <div className="dd">원본 업로드, AI 장면분석 검수</div>
            </div>
            <div className="dept">
              <div className="di">편집</div>
              <div className="dn">편집·운영팀</div>
              <div className="dd">클립 채택·수정 (HITL 학습 반영)</div>
            </div>
            <div className="dept">
              <div className="di">유통</div>
              <div className="dn">유통·송출팀</div>
              <div className="dd">SMR·멀티채널 배포·스케줄링</div>
            </div>
            <div className="dept">
              <div className="di">광고</div>
              <div className="dn">마케팅팀</div>
              <div className="dd">성과 분석, PPL·광고 수익화</div>
            </div>
          </div>
          <div className="collab">
            <div className="cfeat">
              <div className="ck">✓</div>
              <div>
                <div className="ct">역할·권한 관리</div>
                <div className="cs">부서·직무별 접근 권한과 승인 단계 설정</div>
              </div>
            </div>
            <div className="cfeat">
              <div className="ck">✓</div>
              <div>
                <div className="ct">공유 미디어 라이브러리</div>
                <div className="cs">원본·클립·메타데이터를 팀 전체가 한곳에서</div>
              </div>
            </div>
            <div className="cfeat">
              <div className="ck">✓</div>
              <div>
                <div className="ct">승인 워크플로우</div>
                <div className="cs">검수·코멘트·버전 관리로 협업 라인 일원화</div>
              </div>
            </div>
            <div className="cfeat">
              <div className="ck">✓</div>
              <div>
                <div className="ct">팀 성과 대시보드</div>
                <div className="cs">채널·부서별 생산성과 성과를 한눈에</div>
              </div>
            </div>
          </div>
          <p className="wsnote">
            아침에 출근해 STEP D를 열고, <b>하루의 영상 운영을 모두 이 안에서</b>. 부서가 늘수록, 회사가 떠날 수 없는 업무의 중심이 됩니다.
          </p>
        </div>
      </section>

      {/* FEATURES */}
      <section className="sec" id="features">
        <div className="wrap">
          <div className="center">
            <span className="tag">핵심 기능</span>
            <h2 style={{ marginTop: 18 }}>
              범용 도구가 못 푸는 것을,
              <br />
              한국 미디어에 맞춰 풉니다
            </h2>
          </div>
          <div className="feat">
            <div className="fcard">
              <div className="ic">🎬</div>
              <h3>물량이 아니라, 이해</h3>
              <p>잘 된 영상을 학습해, 이 채널 시청자가 어떤 장면을 좋아하는지 따라갑니다. 그냥 시간 단위로 자르는 도구와는 다른 차원입니다.</p>
              <ul>
                <li>잘 되는 채널을 레퍼런스로 학습</li>
                <li>한국어·방송 콘텐츠에 특화</li>
                <li>쓸수록 이 채널에 맞아짐 (장면분류 0.99)</li>
              </ul>
            </div>
            <div className="fcard">
              <div className="ic">⚡</div>
              <h3>원클릭 클립·쇼츠·썸네일</h3>
              <p>6단계 생성 파이프라인이 하이라이트를 찾아 클립·쇼츠·썸네일·자막까지 자동 생성. 제작 리드타임을 53% 단축합니다.</p>
              <ul>
                <li>생성 정합 A/B 선호도 +68%p</li>
                <li>클립 채택률 0.85 (P@K)</li>
                <li>운영자 검수·수정이 곧 학습 신호</li>
              </ul>
            </div>
            <div className="fcard">
              <div className="ic">📡</div>
              <h3>멀티채널 배포 + 광고·커머스 수익화</h3>
              <p>YouTube·네이버TV·인스타·틱톡·Meta로 한 번에 배포하고, 국내 고유 유통망 SMR로 광고 수익화. 영상 속 상품은 커머스로 연결해 판매 수수료까지 법니다.</p>
              <ul>
                <li>SMR·지상파·종편 VOD 워크플로우</li>
                <li>PPL·광고 구간 분석</li>
                <li>커머스 제휴 판매(쿠팡·올리브영·무신사 등)</li>
              </ul>
            </div>
            <div className="fcard">
              <div className="ic">📊</div>
              <h3>성과로 이어지는 데이터 루프</h3>
              <p>배포 성과가 다시 엔진 학습으로 되돌아오는 HITL 데이터 플라이휠. 운영할수록 정확해지는 데이터 해자를 쌓습니다.</p>
              <ul>
                <li>채널별 성과 대시보드·리포팅</li>
                <li>메타데이터 정합률 1.00</li>
                <li>인물 식별정보 비저장 설계</li>
              </ul>
            </div>
          </div>
        </div>
      </section>

      {/* COMPARE */}
      <section
        className="sec"
        style={{ background: "var(--bg2)", borderTop: "1px solid var(--line)", borderBottom: "1px solid var(--line)" }}
      >
        <div className="wrap">
          <div className="center">
            <span className="tag">비교</span>
            <h2 style={{ marginTop: 18 }}>OpusClip vs STEP D</h2>
          </div>
          <div className="cmp">
            <table>
              <thead>
                <tr>
                  <th>항목</th>
                  <th>OpusClip</th>
                  <th>STEP D</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>학습 방식</td>
                  <td>전 세계 평균 패턴(범용)</td>
                  <td>그 채널의 시청자를 학습</td>
                </tr>
                <tr className="hl">
                  <td>무엇을 자르나</td>
                  <td>시간 단위 + 바이럴 점수</td>
                  <td>왜 먹혔는지 이해해 선별</td>
                </tr>
                <tr>
                  <td>한국어·방송</td>
                  <td>영어권 중심, 한국 방송 약함</td>
                  <td>한국어·방송 콘텐츠 특화</td>
                </tr>
                <tr className="hl">
                  <td>다루는 범위</td>
                  <td>클립 만들기 단일 기능</td>
                  <td>제작+유통+수익화 통합(미디어 OS)</td>
                </tr>
                <tr>
                  <td>국내 유통·수익화</td>
                  <td>미대응</td>
                  <td>SMR·광고·커머스 내장</td>
                </tr>
                <tr className="hl">
                  <td>주 고객</td>
                  <td>개인 크리에이터(B2C 셀프서브)</td>
                  <td>방송사·MCN(B2B) 우선</td>
                </tr>
                <tr>
                  <td>품질 변화</td>
                  <td>고정(범용)</td>
                  <td>쓸수록 정확해짐</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p style={{ margin: "18px auto 0", maxWidth: 760, textAlign: "center", fontSize: 13, color: "var(--mut)", lineHeight: 1.6 }}>
            <b>OpusClip</b> ㅣ 2022년 美 설립 · 1,000만+ 유저 · ARR 약 $20M · 밸류 $215M(SoftBank Vision Fund 2 투자, 2025.3). 클리핑 카테고리는 이미 검증된 시장입니다. 단 그들은 <b>개인·범용·클립 단일</b>, STEP D는 <b>방송 B2B·이해 기반·운영 OS</b>입니다.
          </p>
        </div>
      </section>

      {/* MARKET */}
      <section className="sec" id="market">
        <div className="wrap">
          <div className="center">
            <span className="tag">시장 · GO-TO-MARKET</span>
            <h2 style={{ marginTop: 18 }}>
              방송사에서 시작해,
              <br />
              K-미디어 전체와 동남아로 확장
            </h2>
            <p className="lead">가장 검증받기 어려운 방송사(KT ENA)에서 진입하고, 그 레퍼런스를 무기로 국내 하위 시장과 동남아로 두 방향 확장합니다.</p>
          </div>
          <div className="mkt-flow" style={{ display: "grid", gridTemplateColumns: "1.05fr 1fr", gap: 22, marginTop: 50, alignItems: "stretch" }}>
            <div style={{ background: "var(--grad)", borderRadius: 18, padding: "34px 32px", color: "#fff", display: "flex", flexDirection: "column", justifyContent: "center", boxShadow: "0 14px 36px rgba(108,92,231,.18)" }}>
              <div style={{ fontSize: 13, fontWeight: 700, letterSpacing: 1.2, opacity: 0.85 }}>LAND · 진입점</div>
              <div style={{ fontSize: 27, fontWeight: 800, marginTop: 8, lineHeight: 1.2 }}>한국 방송사 · PP</div>
              <div style={{ fontSize: 15, marginTop: 12, opacity: 0.94, lineHeight: 1.65 }}>
                KT ENA 방송 현장 실증 ㅣ 리드타임 53%↓ (17H→8H)
                <br />
                누적 1,863클립 · 활성 프로그램 13
              </div>
            </div>
            <div style={{ display: "grid", gridTemplateRows: "1fr 1fr", gap: 22 }}>
              <div className="fcard" style={{ borderLeft: "4px solid var(--acc)", padding: "24px 28px" }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: "var(--acc)" }}>EXPAND ①　한국 Down-market ↓</div>
                <div style={{ fontSize: 20, fontWeight: 700, margin: "6px 0 5px" }}>MCN · 제작사 · 크리에이터</div>
                <div style={{ color: "var(--mut)", fontSize: 14.5, lineHeight: 1.55 }}>
                  한국 콘텐츠산업 <b style={{ color: "var(--txt)" }}>162조원</b> · 방송영상 25.4조 · 크리에이터 미디어 5.3조
                </div>
              </div>
              <div className="fcard" style={{ borderLeft: "4px solid var(--acc2)", padding: "24px 28px" }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: "var(--acc2)" }}>EXPAND ②　동남아 수출 →</div>
                <div style={{ fontSize: 20, fontWeight: 700, margin: "6px 0 5px" }}>말레이시아 Spherix 외 SEA</div>
                <div style={{ color: "var(--mut)", fontSize: 14.5, lineHeight: 1.55 }}>
                  SEA 스트리밍 <b style={{ color: "var(--txt)" }}>$39억→$100억</b> (CAGR 10.9%) · APAC 디지털콘텐츠 $457→1,324억
                </div>
              </div>
            </div>
          </div>
          <div className="mkt-ladder" style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 18, marginTop: 22 }}>
            <div style={{ background: "var(--bg2)", border: "1px solid var(--line)", borderRadius: 16, padding: "22px 24px" }}>
              <div style={{ fontSize: 12, fontWeight: 800, color: "var(--acc)", letterSpacing: 0.5 }}>글로벌 시장</div>
              <div style={{ fontSize: 21, fontWeight: 800, marginTop: 4 }}>AI 미디어 $99B</div>
              <div style={{ color: "var(--mut)", fontSize: 13, marginTop: 4 }}>2030 · 연 24% 성장 (Grand View)</div>
            </div>
            <div style={{ background: "var(--bg2)", border: "1px solid var(--line)", borderRadius: 16, padding: "22px 24px" }}>
              <div style={{ fontSize: 12, fontWeight: 800, color: "var(--acc)", letterSpacing: 0.5 }}>국내 시장</div>
              <div style={{ fontSize: 21, fontWeight: 800, marginTop: 4 }}>한국 콘텐츠 162조</div>
              <div style={{ color: "var(--mut)", fontSize: 13, marginTop: 4 }}>방송영상 25.4조 + 크리에이터 5.3조</div>
            </div>
            <div style={{ background: "var(--grad)", borderRadius: 16, padding: "22px 24px", color: "#fff" }}>
              <div style={{ fontSize: 12, fontWeight: 800, opacity: 0.85, letterSpacing: 0.5 }}>우리 진입</div>
              <div style={{ fontSize: 21, fontWeight: 800, marginTop: 4 }}>국내 방송사·MCN 900곳</div>
              <div style={{ fontSize: 13, marginTop: 4, opacity: 0.9 }}>단가는 KT ENA 실측 · 3년차 50곳+B2C 2만 = 156억</div>
            </div>
          </div>
          <div style={{ marginTop: 22, background: "rgba(14,165,196,.07)", border: "1px solid rgba(14,165,196,.22)", borderRadius: 14, padding: "18px 26px", display: "flex", gap: 14, alignItems: "center", flexWrap: "wrap" }}>
            <span style={{ fontWeight: 800, color: "var(--acc2)", letterSpacing: 0.6 }}>WHY NOW</span>
            <span style={{ color: "var(--txt)", fontSize: 15 }}>
              글로벌 AI 미디어·엔터 시장 <b style={{ color: "var(--acc2)" }}>$26B → $99B (CAGR 24.2%, 2030)</b> ㅣ 우리는 &apos;AI 생성&apos;이 아니라 콘텐츠 <b>운영·효율화·수익화</b> 시장
            </span>
          </div>
          <div style={{ color: "var(--mut2)", fontSize: 12, marginTop: 14, textAlign: "center" }}>
            출처: Grand View Research(2025) · PwC GEMO 2025 · KOCCA · IMARC · S&amp;P Global
          </div>
        </div>
      </section>

      {/* REVENUE CALCULATOR */}
      <section
        className="sec"
        id="calc"
        style={{ background: "var(--bg2)", borderTop: "1px solid var(--line)", borderBottom: "1px solid var(--line)" }}
      >
        <div className="wrap">
          <div style={{ textAlign: "center" }}>
            <span className="tag">숫자로 보기</span>
            <h2 style={{ marginTop: 18 }}>방송사 몇 곳만 잡으면, 매출이 이만큼</h2>
            <p className="lead">슬라이더를 움직여 보세요. 단가는 KT ENA 실측 기반입니다.</p>
          </div>
          <div style={{ maxWidth: 860, margin: "32px auto 0", background: "#fff", border: "1px solid var(--line)", borderRadius: 16, padding: 28 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: "#6C5CE7", marginBottom: 10 }}>B2B · 방송사·MCN</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 28 }}>
              <div>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 14, color: "var(--mut)" }}>
                  <span>방송사 고객사 수</span>
                  <strong style={{ color: "#6C5CE7" }}>{comma(cust)}곳</strong>
                </div>
                <input type="range" min={1} max={900} value={cust} onChange={(e) => setCust(+e.target.value)} style={{ width: "100%", marginTop: 10, accentColor: "#6C5CE7" }} />
                <div style={{ fontSize: 12, color: "var(--mut2)" }}>현재 목표 ~50곳 ㆍ 끝까지 = 시장 전체 900곳(100%)</div>
              </div>
              <div>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 14, color: "var(--mut)" }}>
                  <span>고객당 월 사용료</span>
                  <strong style={{ color: "#6C5CE7" }}>{arpu}만원</strong>
                </div>
                <input type="range" min={300} max={900} step={50} value={arpu} onChange={(e) => setArpu(+e.target.value)} style={{ width: "100%", marginTop: 10, accentColor: "#6C5CE7" }} />
                <div style={{ fontSize: 12, color: "var(--mut2)" }}>쓸수록 오른다 (300만 → 900만)</div>
              </div>
            </div>
            <div style={{ fontSize: 13, fontWeight: 700, color: "#1597B0", margin: "24px 0 10px" }}>B2C · 크리에이터 (3년차~ 확장)</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 28 }}>
              <div>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 14, color: "var(--mut)" }}>
                  <span>B2C 계정 수</span>
                  <strong style={{ color: "#1597B0" }}>{comma(bc)}</strong>
                </div>
                <input type="range" min={0} max={50000} step={500} value={bc} onChange={(e) => setBc(+e.target.value)} style={{ width: "100%", marginTop: 10, accentColor: "#22C3E0" }} />
                <div style={{ fontSize: 12, color: "var(--mut2)" }}>셀프서브 ㆍ 끝까지 = 시장 전체</div>
              </div>
              <div>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 14, color: "var(--mut)" }}>
                  <span>B2C 월 요금</span>
                  <strong style={{ color: "#1597B0" }}>{bp}만원</strong>
                </div>
                <input type="range" min={1} max={6} step={0.5} value={bp} onChange={(e) => setBp(+e.target.value)} style={{ width: "100%", marginTop: 10, accentColor: "#22C3E0" }} />
                <div style={{ fontSize: 12, color: "var(--mut2)" }}>OpusClip $29 · Vrew ₩9,900~39,600 벤치</div>
              </div>
            </div>
            <div style={{ fontSize: 13, fontWeight: 700, color: "#6C5CE7", margin: "24px 0 10px" }}>글로벌 · 해외 방송사·파트너 (수출)</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 28 }}>
              <div>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 14, color: "var(--mut)" }}>
                  <span>해외 방송사·파트너 수</span>
                  <strong style={{ color: "#6C5CE7" }}>{comma(glb)}곳</strong>
                </div>
                <input type="range" min={0} max={2000} step={10} value={glb} onChange={(e) => setGlb(+e.target.value)} style={{ width: "100%", marginTop: 10, accentColor: "#6C5CE7" }} />
                <div style={{ fontSize: 12, color: "var(--mut2)" }}>동남아 → 글로벌 (KT ENA 레퍼런스 기반)</div>
              </div>
              <div>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 14, color: "var(--mut)" }}>
                  <span>해외 월 사용료</span>
                  <strong style={{ color: "#6C5CE7" }}>{gp}만원</strong>
                </div>
                <input type="range" min={200} max={900} step={50} value={gp} onChange={(e) => setGp(+e.target.value)} style={{ width: "100%", marginTop: 10, accentColor: "#6C5CE7" }} />
                <div style={{ fontSize: 12, color: "var(--mut2)" }}>현지화 감안 보수 단가</div>
              </div>
            </div>
            <div className="calc-out" style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 14, marginTop: 28 }}>
              <div style={{ textAlign: "center", background: "#F7F7FB", borderRadius: 12, padding: 16 }}>
                <div style={{ fontSize: 12, color: "var(--mut)" }}>연 매출</div>
                <div style={{ fontSize: 26, fontWeight: 800, color: "#1B1B2F", marginTop: 6 }}>{calc.rev}</div>
              </div>
              <div style={{ textAlign: "center", background: "#F7F7FB", borderRadius: 12, padding: 16 }}>
                <div style={{ fontSize: 12, color: "var(--mut)" }}>연 비용</div>
                <div style={{ fontSize: 26, fontWeight: 800, color: "#E05260", marginTop: 6 }}>{calc.cost}</div>
              </div>
              <div style={{ textAlign: "center", background: "#F7F7FB", borderRadius: 12, padding: 16 }}>
                <div style={{ fontSize: 12, color: "var(--mut)" }}>연 수익</div>
                <div style={{ fontSize: 26, fontWeight: 800, color: "#6C5CE7", marginTop: 6 }}>{calc.pro}</div>
              </div>
              <div style={{ textAlign: "center", background: "#F7F7FB", borderRadius: 12, padding: 16 }}>
                <div style={{ fontSize: 12, color: "var(--mut)" }}>마진율</div>
                <div style={{ fontSize: 26, fontWeight: 800, color: "#1597B0", marginTop: 6 }}>{calc.mar}</div>
              </div>
            </div>
            <div style={{ marginTop: 14, textAlign: "center", background: "#F2F0FE", borderRadius: 10, padding: 12, fontSize: 14, color: "#6C5CE7", fontWeight: 700 }}>
              + 첫해 세팅비 {calc.setup} <span style={{ fontWeight: 400, color: "var(--mut)" }}>(국내+해외 방송사 {calc.setN}곳 × 3,000만, 1회성)</span>
            </div>
            <p style={{ fontSize: 12, color: "var(--mut2)", marginTop: 14, textAlign: "center" }}>
              연 비용 = 매출에 비례(매출 늘면 비용도 함께) · 마진 30~50%(국내·글로벌·B2C 블렌디드) · 세팅비 3,000만/신규사(1회) · 끝까지 당기면 시장 100%
            </p>
          </div>
        </div>
      </section>

      {/* TRUST LOGOS */}
      <section className="sec center" style={{ paddingTop: 40 }}>
        <div className="wrap">
          <span className="tag">신뢰</span>
          <h2 style={{ marginTop: 18 }}>현장에서 이미 쓰이고 있습니다</h2>
          <p className="lead">KT ENA 방송 현장에서 운영 중. 그 외 파트너는 협약·예정 단계입니다.</p>
          <div className="logos">
            <div className="lchip">
              국내 대형 방송 <b>PP (KT ENA)</b> · 운영 중
            </div>
            <div className="lchip">
              대형 연예인 유튜브 채널 <b>구독 111만+</b> · 예정
            </div>
            <div className="lchip">
              중견 <b>MCN 2곳</b> · 예정
            </div>
            <div className="lchip">
              말레이시아 <b>수출 파트너</b> · 예정
            </div>
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="sec" id="cta">
        <div className="wrap">
          <div className="ctab">
            <h2>
              오늘 올린 영상이,
              <br />
              내일의 회사 자산이 됩니다
            </h2>
            <p>영상 원본 하나로 클립부터 배포·수익화까지. STEP D를 무료로 시작해 보세요.</p>
            <div style={{ display: "flex", gap: 14, justifyContent: "center", flexWrap: "wrap" }}>
              <Link href={APP_URL} className="btn btn-p">
                들어가기 →
              </Link>
              <a href="#" className="btn btn-g">
                도입 상담 신청
              </a>
            </div>
          </div>
        </div>
      </section>

      {/* FOOTER */}
      <footer>
        <div className="wrap">
          <div className="foot">
            <div>
              <div className="logo">
                <span className="mark">D</span>STEP D
              </div>
              <p>한국 미디어를 위한 AI 영상 운영·생성 자동화 SaaS. &lsquo;K-콘텐츠를 만드는 공장&rsquo;을 제공합니다.</p>
            </div>
            <div className="col">
              <h5>제품</h5>
              <a href="#features">핵심 기능</a>
              <a href="#how">작동 방식</a>
            </div>
            <div className="col">
              <h5>회사</h5>
              <a href="#">㈜스텝에이아이</a>
              <a href="#">파트너십</a>
              <a href="#">채용</a>
            </div>
            <div className="col">
              <h5>문의</h5>
              <a href="#">데모 신청</a>
              <a href="#">도입 상담</a>
              <a href="mailto:contact@stepai.kr">contact@stepai.kr</a>
            </div>
          </div>
          <div className="copy">© 2026 STEP AI Inc. (주식회사 스텝에이아이) · STEP D는 ㈜스텝에이아이의 서비스입니다.</div>
        </div>
      </footer>
    </div>
  );
}
