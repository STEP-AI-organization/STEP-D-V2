# 제목 우선 Beat 선택 계획

작성일: 2026-07-31  
대상: `core/recommend.py`, `core/beat_annot.py`, `core/analyze.py`

## 목표

beat 자체는 잘 나오는데, AI가 beat를 **서사적으로 묶는 데 실패**하는 문제를 고친다.
해결 방향은 명확하다.

**beat를 먼저 고르는 것이 아니라, 서사 제목을 먼저 잡고 그 제목에 맞는 beat 묶음을 선택한다.**

## 문제 정의

현재 문제는 다음과 같다.

- 같은 화면 안에서 대화 주제만 바뀌면 beat가 불필요하게 분리된다.
- 반대로 실제로는 하나의 이야기인데, AI가 beat를 따로따로 해석한다.
- 그래서 추천 결과가 “장면 단위 나열”처럼 보이고, “서사 단위 선택”이 되지 않는다.

즉, 실패 지점은 beat 생성보다 **beat 조합 기준**에 있다.

## 핵심 원칙

1. **제목이 먼저다**
   - beat를 보기 전에, 이 구간이 어떤 이야기인지 한 문장 제목으로 먼저 정의한다.
   - 제목은 단순 라벨이 아니라 beat를 묶는 기준점이다.

2. **beat는 제목의 증거다**
   - beat는 독립 후보가 아니라, 제목을 설명하는 근거 조각이다.
   - 같은 제목 아래 들어가는 beat들은 서사적으로 이어져야 한다.

3. **맥락이 안 바뀌면 묶는다**
   - 화제 전환만 있고 서사 축이 유지되면 같은 story pack으로 본다.
   - 장면이 조금 흔들려도 이야기 축이 같으면 분리하지 않는다.

4. **beat 선택은 title-conditioned ranking이다**
   - “좋아 보이는 beat”를 고르는 게 아니라
   - “이 제목을 가장 잘 설명하는 beat 묶음”을 고른다.

## 실행 구조

```text
transcript + scenes + narrative segments
  -> story_title 후보 생성
  -> title별 core beat 묶음 선택
  -> beat 묶음 합치기/유지 판단
  -> shorts/clip/hightlight 생성
```

## 단계별 계획

### 1. 서사 제목 먼저 생성

- `narrative` 단계에서 각 스토리 블록의 제목을 먼저 확정한다.
- 제목은 아래를 만족해야 한다.
  - 한 줄로 읽힌다
  - beat 여러 개를 묶을 수 있다
  - 이야기의 중심 사건/관계/갈등을 드러낸다

예시:
- `둘의 대화가 갈라지는 순간`
- `같은 공간, 다른 주장`
- `한마디가 분위기를 바꾸는 장면`

### 2. 제목별 beat 후보군 구성

- beat를 독립적으로 점수화하지 말고, title 후보에 연결한다.
- 각 beat는 다음 중 하나를 만족해야 한다.
  - 제목의 전개를 이어준다
  - 제목의 반전/전환/결말을 만든다
  - 제목의 근거가 되는 핵심 발화/반응을 담는다

### 3. 제목 기반 beat 묶기

- beat 간 경계가 있어도, 제목 축이 같으면 묶는다.
- 아래 조건이면 같은 묶음으로 유지한다.
  - 같은 화자 흐름
  - 같은 갈등 축
  - 같은 논점/질문/반응 구조
  - 화면 변화가 약함

### 4. 제목과 맞지 않는 beat 제거

- 제목을 흔드는 beat는 제거한다.
- 예를 들어, 같은 화면에서 잡담만 늘어나는 구간은 title pack 밖으로 보낸다.
- 제목과 무관한 side beat는 별도 후보로 낮춘다.

### 5. 추천은 story pack 단위로 수행

- 최종 추천은 beat 단품이 아니라 story pack 단위로 뽑는다.
- short/clip/highlight는 이 pack을 실현하는 출력물이다.
- beat는 내부 구성 요소일 뿐, 최종 의사결정 단위가 아니다.

## 구현 포인트

### `core/recommend.py`

- `recommend_narrative_first()`의 상위 입력을 beat가 아니라 title/story pack으로 바꾼다.
- `propose_shorts_beat_only()`는 유지하되, 입력 beat 리스트를 title별로 먼저 묶는다.
- short 생성 전에 `story_title` 기준으로 beat 그룹을 재정렬한다.

### `core/beat_annot.py`

- 각 beat에 `story_title` 또는 `story_anchor`를 붙인다.
- beat title은 독립 생성하지 말고, 상위 story title을 보조하도록 만든다.
- beat summary는 “이 beat가 제목에 어떤 역할을 하는지” 중심으로 쓴다.

### `core/analyze.py`

- narrative 생성 후 beat 생성 순서를 유지하되,
- beat annotation 전에 title 후보를 먼저 저장한다.
- 추천 단계로 넘길 때 title-first grouping 메타를 함께 넘긴다.

## 평가 기준

- beat가 따로 노는 느낌이 줄어든다.
- 같은 서사축의 beat가 함께 묶인다.
- 제목을 보면 어떤 beat 묶음인지 설명 가능해야 한다.
- 추천 결과가 장면 나열이 아니라 이야기 덩어리처럼 보인다.

## 완료 기준

1. beat 단위가 아니라 title 단위로 추천 근거를 설명할 수 있다.
2. 같은 화면의 대화 주제 전환이 있어도, 서사가 유지되면 묶인다.
3. AI가 “좋은 beat”가 아니라 “좋은 이야기”를 먼저 고르는 구조가 된다.

