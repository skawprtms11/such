# 더퓨어랩 주문접수시스템

화주(더퓨어랩) 영업사원이 등록한 출고 주문을 물류사(용마물류) 담당자가 처리하고,
검수·상차까지 실시간으로 확인하는 웹/모바일 시스템.

---

## ⚠️ 작업 규칙 (반드시 지킬 것)

**특정 메뉴를 수정하기 전에 해당 메뉴의 문서를 먼저 읽는다.**
문서에는 화면 구성, 데이터 흐름, 권한 조건, 상태 전이 규칙이 정리되어 있어
코드만 보고는 알 수 없는 업무 규칙이 담겨 있다.

| 메뉴 | 문서 (작업 전 필독) | 코드 | 라우트 |
|---|---|---|---|
| 주문정보등록 | [docs/orders.md](docs/orders.md) | `assets/js/pages/orders.js` | `#/orders` |
| 주문처리현황 | [docs/status.md](docs/status.md) | `assets/js/pages/status.js` | `#/status` |
| 출고주문처리 | [docs/shipping.md](docs/shipping.md) | `assets/js/pages/shipping.js` | `#/shipping` |  ← 웹/모바일 화면이 다름
| 당일상차리스트 | [docs/loading.md](docs/loading.md) | `assets/js/pages/loading.js` | `#/loading` |
| 검수 (바코드) | [docs/inspect.md](docs/inspect.md) | `assets/js/pages/inspect.js` | `#/inspect/:id` |
| 이슈등록 | [docs/issues.md](docs/issues.md) | `assets/js/pages/issues.js` | `#/issues` |
| 사용자관리 | [docs/users.md](docs/users.md) | `assets/js/pages/users.js` | `#/users` |

**바코드 스캔 테스트 방법**은 [docs/testing.md](docs/testing.md) 에 정리되어 있다.
(테스트용 바코드는 `barcodes.html` 에서 자동 생성된다)

공통 규약(화면 모듈 인터페이스, 데이터 계층, 권한 판정)은
[docs/common.md](docs/common.md) 에 정리되어 있다. 새 화면을 추가할 때 먼저 읽는다.

### 작업 순서

1. 대상 메뉴의 `docs/*.md` 를 읽는다.
2. 코드를 수정한다.
3. **업무 규칙이 바뀌었으면 같은 문서를 함께 갱신한다.** (화면 구성, 상태 전이, 권한 조건)
4. `npm run lint` 로 검사한다.
5. 화면 동작을 브라우저에서 확인한다.

---

## 기술 구성

| 항목 | 내용 |
|---|---|
| 빌드 | Vite 8 (번들러 겸 개발 서버) |
| 언어 | 순수 ES 모듈 JavaScript (프레임워크 없음) |
| 스타일 | 단일 CSS 파일 + CSS 변수 (`assets/css/app.css`) |
| PWA | vite-plugin-pwa — 폰 홈화면 설치, 오프라인 캐시 |
| 서버 | Supabase (구축 완료 — Postgres · Auth · Realtime · RLS) |
| 검사 | ESLint 10 (flat config) |

프레임워크를 쓰지 않는 이유는 **구현·배포 속도** 때문이다.
정적 파일만 올리면 어디서든 뜬다. 화면 코드 자체는 gzip 25KB 수준이고,
여기에 Supabase 클라이언트가 더해져 첫 로드가 gzip 65KB 정도다.
(카메라 스캔용 ZXing 은 내장 인식기가 없는 기기에서만 따로 내려받는다)
이 전제를 깨는 라이브러리 추가는 신중히 판단한다.

### 명령어

```
npm run dev        개발 서버 (HMR, http://localhost:5173)
npm run dev:https  HTTPS 개발 서버 (휴대폰 카메라 스캔 테스트용)
npm run build      프로덕션 빌드 → dist/
npm run preview    빌드 결과물 확인 (http://localhost:4173)
npm run lint       코드 검사  /  npm run lint:fix  자동 수정
```

⚠️ **카메라는 HTTPS 또는 localhost 에서만 동작한다.**
휴대폰에서 `http://192.168.x.x:5173` 으로 접속하면 카메라가 차단되므로
실기기 스캔 테스트에는 `npm run dev:https` 를 쓴다. ([docs/testing.md](docs/testing.md) 참고)

`npm run dev` 는 `Network:` 주소도 출력한다. 같은 와이파이의 휴대폰에서 그 주소로
접속하면 모바일 화면과 바코드 스캔을 실기기에서 확인할 수 있다.

### 배포 🔑

**Netlify 한 곳으로만 배포한다.** main 에 반영되면 자동으로 빌드·배포된다.

| 항목 | 값 |
|---|---|
| 사이트 | `suchool` — https://suchool.netlify.app |
| 빌드 설정 | `netlify.toml` (`npm run lint && npm run build` → `dist`) |
| 접속 설정 | Netlify 사이트 환경변수의 `VITE_SUPABASE_URL` `VITE_SUPABASE_ANON_KEY` `VITE_DATA_SOURCE` |

- **검사도 Netlify 가 한다.** `npm run lint` 가 실패하면 배포되지 않는다
- PR 마다 **deploy preview** 가 만들어진다 (`deploy-preview-<번호>--suchool.netlify.app`).
  같은 환경변수를 쓰므로 프리뷰도 실제 서버를 본다
- ⚠️ **키를 `netlify.toml` 에 넣지 않는다.** 사이트 환경변수로만 관리한다
- GitHub Pages 배포는 걷어냈다. 배포처가 둘이면 접속 설정을 양쪽에 맞춰야 하고,
  한쪽만 반영되어 같은 코드인데 화면이 달라 보이는 일이 생긴다

---

## 폴더 구조

```
thefurerap/
├─ CLAUDE.md              이 파일
├─ docs/                  메뉴별 상세 문서 (작업 전 필독)
├─ index.html             로그인 화면
├─ barcodes.html          테스트용 바코드 시트 (Code128, 인쇄 가능)
├─ app.html               앱 셸 (사이드바 + 상단바 + 하단 탭바)
├─ assets/
│  ├─ css/app.css         전체 스타일
│  └─ js/
│     ├─ app.js           라우터 · 메뉴 렌더링 · 셸 제어
│     ├─ config.js        권한 매트릭스, 처리 단계, 메뉴 정의 등 모든 상수
│     ├─ auth.js          로그인 세션 · 권한 판정 can()
│     ├─ db.js            데이터 접근 계층 (화면은 이 모듈만 호출)
│     ├─ store.js         저장소 계층 (localStorage / Supabase 를 가른다)
│     ├─ supabase.js      Supabase 클라이언트 (싱글턴)
│     ├─ icons.js        단색 라인 SVG 아이콘 (currentColor 기반)
│     ├─ steps.js        출고 처리 단계 계산 (여러 화면이 공유)
│     ├─ scanner.js      바코드 스캔 공통 모듈
│     ├─ barcode.js      Code128 바코드 생성 (SVG)
│     ├─ mock-data.js     mock 모드용 샘플 데이터
│     ├─ util.js          날짜·숫자 포맷, 모달, 토스트, CSV 다운로드
│     └─ pages/           화면 모듈 6개
├─ public/icons/          PWA 아이콘 (해시 없이 그대로 복사됨)
│                        icon.svg(파비콘) · icon-192/512.png(설치)
│                        icon-maskable-512.png(안드로이드) · apple-touch-icon.png(iOS)
├─ supabase/schema.sql    Supabase 구축 시 실행할 DDL (테이블·트리거·RLS)
└─ vite.config.js         빌드 설정 + 개발용 서비스워커 정리 플러그인
```

---

## 핵심 개념

### 1. 출고 처리 단계 🔑

주문 1건은 **단계별 완료 시각**으로 진행 상태를 표현한다. 값이 있으면 완료다.

```
주문처리 → 출고작업 → [요청작업] → 검수작업 → 출고적치 → [조정작업] → [추가작업] → 상차작업
```

| 단계 | 저장 필드 | 완료되는 곳 |
|---|---|---|
| 주문처리 | `confirmed_at` | 주문정보등록의 접수 체크 |
| 출고작업 | `ship_done_at` | 출고주문처리 |
| 요청작업 | `req_work_at` | 출고주문처리 (검수 탭) |
| 검수작업 | `inspect_done_at` | 출고주문처리 |
| 출고적치 | `stow_done_at` | 출고주문처리 (출고적치 탭 - 파렛트 로케이션 전량 입력 시 자동) |
| 조정작업 | *(계산값)* | 조정요청을 모두 확인 처리할 때 |
| 추가작업 | `extra_done_at` | 출고주문처리 |
| 상차작업 | `loaded_at` | 당일상차리스트 |

- **요청작업**은 주문에 추가작업(`extra_works`)이 등록된 경우에만 표시된다
- **조정작업**은 조정요청이 등록된 경우에만 표시된다
- **추가작업**은 추가작업 요청이 등록된 경우에만 표시된다
- 정의는 `config.js` 의 `WORK_STEPS`, 계산은 `assets/js/steps.js` 가 담당한다
  (`visibleSteps` `readyToLoad` `stepRate` `currentStep`)
- **당일상차리스트에는 상차작업을 제외한 모든 단계가 끝난 주문만 나온다** (`readyToLoad`)
- 상차작업까지 끝나면 용마담당자가 **완료처리**(`closed_at`)로 주문을 마감한다.
  단계가 아니라 마감 표시이며, 주문처리현황의 탭을 가르는 기준이다
  ([docs/status.md](docs/status.md) 참고)
- 숫자 단계(`stage`)는 조건부 단계를 표현할 수 없어 폐기했다. 되살리지 않는다

### 1-1. 추가작업 요청

이슈등록에서 **유형이 `작업요청`** 인 건을 주문번호로 이어 붙여 추가작업 요청으로 본다
(`config.js` 의 `EXTRA_TASK_TYPE`). 전용 등록 화면이 없어 기존 이슈등록을 재사용한 것이다.
자세한 내용은 [docs/shipping.md](docs/shipping.md) 참고.

### 2-1. 진행상태 (주문정보등록 화면)

`stage` 와 별개로, 주문정보등록 목록에 표시하는 요약 상태다. **저장하지 않고 계산한다.**

```
취소(canceled_at) > 완료(stage 5) > 진행(confirmed_at) > 대기
```

값 목록은 `config.js` 의 `PROGRESS`. 자세한 규칙은 [docs/orders.md](docs/orders.md) 참고.

### 2. 상차 상태 (load_status)

`stage` 와 별개로 상차 진행을 나타낸다. 상차리스트와 검수 화면에서만 쓴다.

```
대기 ──(상차라벨 바코드를 파렛트 수만큼 스캔)──▶ 검수 ──(상차완료 버튼)──▶ 완료
```

- `대기 → 검수` 는 자동. `db.scanPallet()` 이 전량 스캔을 감지해 전환한다
- `검수 → 완료` 는 수동. **검수 상태에서만** 상차완료 버튼이 나타난다
- `db.completeLoading()` 은 `검수` 가 아닌 건을 거부한다

### 3. 차수 (seq)

등록 화면에서 **신규주문 / 추가주문**을 고르고, **추가주문일 때만 차수가 올라간다.**
`db.createOrder()` 가 `addition` 플래그를 받아 `max(seq) + 1` 을 계산한다.
사용자가 차수를 직접 입력하지는 않는다. 표에서 2차수 이상은 주황색으로 구분 표시한다.

- ⚠️ **같은 주문번호라고 자동으로 차수를 올리지 않는다.** 예전에는 그렇게 했지만
  신규 주문이 2차수로 들어가는 문제가 있어 없앴다 (`trg_set_order_seq` 트리거도 제거)
- 추가주문 대상은 `db.listOpenOrderNos()` 가 준다. **종결된 주문(완료처리·취소)은 빠진다**
- 🔑 **추가주문은 주문번호가 `a11111` → `a11111-1` → `a11111-2` 로 뻗는다.**
  묶음 판정은 주문번호가 아니라 **기준 번호 `base_no`** 로 한다 (1차수는 자기 번호와 같다)
- 일괄등록은 신규주문으로만 들어간다

**상차는 차수를 묶어서 처리한다 🔑** — 추가주문은 1차수와 함께 한 거래처로 배송되므로,
상차대기·당일상차리스트·상차검수는 **같은 `base_no` 의 모든 차수를 하나로 본다**
(`db.getLoadGroup()`). 목록에는 대표(가장 낮은 차수)만 나오고 옆에 `+2건` 배지가 붙는다.
검수·상차완료도 그룹 전체에 적용된다.

### 4. 권한

`config.js` 의 `PERMISSION` 매트릭스가 유일한 출처다.
화면에서는 `can(user, 'download')` 형태로만 판정하고, 역할명을 직접 비교하지 않는다.

| 권한 | 관리자 | 용마담당자 | 화주관리자 | 화주영업팀 | 현장작업자 |
|---|:---:|:---:|:---:|:---:|:---:|
| `viewAll` 전체 조회 | ✅ | ✅ | ✅ | ❌ 본인 등록건만 | ✅ |
| `download` 다운로드 | ✅ | ✅ | ✅ | ✅ | ❌ |
| `createOrder` 주문 등록·수정 | ✅ | ❌ | ✅ | ✅ | ❌ |
| `updateStatus` 출고·검수·적치·상차 | ✅ | ✅ | ❌ | ❌ | ✅ |
| `createIssue` 이슈 등록 | ✅ | ✅ | ✅ | ✅ | ❌ |
| `closeOrder` 출고 완료처리 | ✅ | ✅ | ❌ | ❌ | ❌ |
| `manageUsers` 사용자 권한 변경 | ✅ | ❌ | ❌ | ❌ | ❌ |

**현장작업자**는 협력사 소속으로 앱만 쓴다. 출고주문처리·당일상차리스트는 전부 처리하고,
주문처리현황·이슈등록은 조회만 한다. 이슈 상태 변경은 `updateStatus` 와 `createIssue` 를
함께 가진 역할(관리자·용마담당자)만 할 수 있다.

`viewAll` 이 false 면 각 화면이 `createdBy: user.id` 필터를 붙여 조회한다.

#### 소속 (company)

**주문정보등록 화면만 역할이 아니라 역할 + 소속으로 판정한다.**

| 소속 | 값 | 주문정보등록에서 할 수 있는 일 |
|---|---|---|
| `COMPANY.CUSTOMER` | 고객사 | 등록 · 수정 · 조정요청 (작성) |
| `COMPANY.LOGISTICS` | 용마로지스 | 조회 + 접수/수정/조정 확인 체크, 이력 확인처리 |
| `COMPANY.PARTNER` | 협력사 | **접근 불가** — 앱 메뉴 4개만 쓴다 (`appOnlyCompany()`) |

관리자와 화주관리자는 소속과 무관하게 모두 가능하다.
정책은 `config.js` 의 `ORDER_POLICY`, 판정은 `auth.js` 의 `allow()` 가 한다.
소속은 자유 입력이 아니라 `COMPANY` 목록에서 고른다.

### 5. 데이터 계층 🔑

화면 코드는 **`db.js` 의 함수만** 호출한다. 저장소가 무엇인지 알지 못한다.

```
pages/*.js  →  db.js  →  store.js  →  localStorage  (VITE_DATA_SOURCE=mock)
              (업무 규칙)  (저장소)  →  Supabase      (VITE_DATA_SOURCE=supabase)
```

**업무 규칙은 `db.js` 한 곳에만 둔다.** 차수 계산·이력 기록·단계 동기화·검증은
저장소가 무엇이든 같은 코드를 쓴다. `store.js` 는 읽고 쓰는 방법만 안다.

`store.js` 가 Supabase 모드에서 하는 일은 세 가지다.

| 하는 일 | 방법 |
|---|---|
| 읽기 | 테이블 6개를 한 번에 조회해 `{users, orders, pallets, history, restores, issues}` 로 만든다. 0.7초 캐시로 연속 호출을 묶는다 |
| 쓰기 | 읽은 시점의 스냅샷과 비교해 **바뀐 행만** 반영한다. 통째로 덮어쓰지 않아 남의 변경을 지우지 않는다 |
| 실시간 | Realtime 채널을 구독한다. 끊김에 대비해 느슨한 폴링(15초)도 함께 돈다 |

- ⚠️ **신규 등록(insert)과 수정(update)을 반드시 나눈다.** `upsert` 는 INSERT 로
  취급되어 등록 권한을 요구하는데, 남이 만든 주문의 단계를 처리하는 것은 수정이지
  등록이 아니다. 이걸 합치면 RLS 정책에 걸린다
- 서버로 보낼 컬럼은 `store.js` 의 **화이트리스트**로 추린다. 화면이 임시로 붙인
  값(예: 파렛트의 `label`)이 섞여도 저장이 깨지지 않는다
- `db.subscribe(callback)` 로 실시간 갱신을 구독한다.
  **화면 코드는 저장소가 무엇인지에 영향받지 않는다**

---

## 데이터 모델

`supabase/schema.sql` 이 정식 정의이고, mock 데이터도 같은 필드명을 쓴다.

| 테이블 | 용도 | 주요 필드 |
|---|---|---|
| `profiles` | 사용자 | `name` `email` `company`(고객사/용마로지스) `role` `active` |
| `orders` | 주문 | `order_no` `base_no` `seq` `customer` `ship_req_date` `vehicle_type` `extra_works` `pallet_count` `box_count` `confirmed_at` `ship_done_at` `req_work_at` `inspect_done_at` `extra_done_at` `stow_done_at` `loaded_at` `closed_at` `edit_count` `canceled_at` `inspected` `status` `created_by` |
| `order_history` | 변동사항 이력 | `order_id` `rev` `field` `before_val` `after_val` `memo` `changed_by` `checked_at` |
| `restore_requests` | 조정요청 | `order_id` `type` `reason` `product_code` `qty` `created_by` `checked_at` |
| `pallets` | 검수 바코드 · 적치 로케이션 | `order_id` `barcode` `scanned_at` `location` `picked_at` |
| `issues` | 이슈 | `type` `title` `content` `due_date` `status` |

`orders` 의 `pallet_count`(파렛트수) · `box_count`(박스수) 는 **출고주문처리의
검수작업 탭에서 검수완료 시 수기로 입력**한다 ([docs/shipping.md](docs/shipping.md) 참고).
`item_count`(품목수) · `qty`(출고수량) 는 스키마에는 있으나 **현재 어느 화면에서도
입력하지 않는다.** 아래 열린 이슈 참고.

---

## 열린 이슈

### 1. 품목수 · 출고수량의 입력 경로 미정 🔴

주문 등록 화면에서 제거된 상태라 신규 주문은 `item_count` `qty` 가 `0`이다.
그 결과 주문정보등록·주문처리현황의 **품목수/출고수량 요약이 0으로 집계**된다.

용마담당자 입력 / WMS 연동 중 어느 쪽으로 갈지 결정되면 반영한다.
**이 값을 다루는 작업을 하기 전에 사용자에게 결정 사항을 먼저 확인할 것.**

> **파렛트수는 결정되었다.** 출고주문처리 검수작업 탭에서 검수완료 시
> 총 파렛트수·총 박스수를 용마담당자가 수기로 입력하고, 입력한 수만큼
> 상차 검수 바코드가 생성된다. 검수를 거치지 않은 주문은 여전히 `0` 이라
> 상차 바코드 검수를 할 수 없다.

### 2. 바코드 체계 임시 🟡

상차 검수는 **주문처리현황에서 출력한 상차라벨의 주문번호 바코드**를 파렛트 수만큼
스캔하는 방식이다. 파렛트 레코드는 여전히 `{주문번호}-P01` 형식으로 자동 생성되고
(`mock-data.js` 의 `makePallets`), 그 개별 바코드도 계속 인식한다.
실제 용마물류 파렛트 라벨 체계가 확정되면 교체한다.

### 3. 조정요청 메일 발송 미구현 🟡

조정요청의 `이메일로 발송` 방식은 **요청 기록만 남고 실제 메일은 나가지 않는다.**
발송에는 서버(Supabase Edge Function 등)가 필요하다.
조정 사유 목록(`config.js` 의 `RESTORE_REASONS`)도 실제 업무 사유로 확정되지 않은 임시값이다.

### 4. 로그인 — 해결됨 ✅

Supabase Auth(이메일 + 비밀번호)로 연동했다. 권한은 서버의 RLS 가 강제한다.
`VITE_DATA_SOURCE=mock` 일 때만 예전의 계정 선택 방식으로 동작한다.

- **사용자 추가는 화면에서 할 수 없다.** 로그인 계정(`auth.users`)이 함께 필요하므로
  Supabase 대시보드(Authentication → Users)에서 만든 뒤 `profiles` 행을 넣는다
- 초기 비밀번호는 계정마다 같게 넣어두었다. 각자 바꾸도록 안내한다

---

## 주의사항

- **주문정보등록의 권한은 소속(고객사/용마로지스)까지 본다.** 역할만 보는
  `can()` 대신 `allow(user, ORDER_POLICY.*)` 를 쓴다
- **주문 조작은 처리 단계에 따라 제한된다.** 수정은 상차완료(`stage 5`) 전까지,
  조정요청은 패킹리스트 완료(`stage 4`) 전까지만 가능하다
  ([docs/orders.md](docs/orders.md) 참고)
- **`config.js` 가 상수의 유일한 출처다.** 단계명·역할명·이슈 유형을 화면 코드에
  문자열로 직접 쓰지 않는다.
- **사용자 입력은 반드시 `esc()` 로 이스케이프한다.** 화면이 `innerHTML` 로 렌더링되므로
  이스케이프를 빠뜨리면 XSS 가 된다.
- **화면 모듈의 `render()` 는 정리(cleanup) 함수를 반환해야 한다.** 반환하지 않으면
  화면을 떠난 뒤에도 폴링과 카메라가 계속 돈다.
- 개발 모드에서는 서비스워커를 쓰지 않는다. `vite.config.js` 의 `devUnregisterSw` 플러그인이
  예전에 등록된 서비스워커를 자동으로 해제한다. (캐시된 옛 화면이 보이는 문제 방지)
- **메뉴 아이콘은 이모지가 아니라 `icons.js` 의 단색 라인 SVG 를 쓴다.**
  모바일 하단 탭바에는 `MENUS` 의 `mobile: true` 인 메뉴만 나온다
  ([docs/common.md](docs/common.md#메뉴-정의-configjs-의-menus) 참고)
- Supabase 키는 `.env.local` 에 넣는다. 소스에 하드코딩하지 않는다. (`.env.example` 참고)

<!--
  하네스 부장 (Harness-Bujang) — section template appended to the user's CLAUDE.md.
  `init` reads this file, fills `{{...}}` placeholders, then appends to the project's CLAUDE.md.
-->

## Harness Engineering (agent organization)

### Structure

- **Command entry**: Claude Code CLI only. The chat room is observe-only.
- **부장 = Main Claude's persona** 🎭 (NOT a real subagent — Claude Code constraint)
  - Main Claude reads `.claude/agents/director.md` and adopts 부장's role / tone / responsibilities
  - Actual team calls and code work are done by Main Claude directly
  - Chat-room INSERTs are proxied by Main Claude under each role's name
- **Real subagents** (16 teams): `.claude/agents/*.md` — invoked via the `Agent` tool
  - Engineering 9: `dev-team` · `architect-team` · `code-review-team` · `security-team` · `db-guard-team` · `qa-team` · `verifier-team` · `doc-sync-team` · `consultant`
  - Content 7: `research-team` · `analysis-team` · `script-team` · `image-team` · `voice-team` · `edit-team` · `content-qa-team`
- **공동대표 persona**: `.claude/agents/cofounder.md` — peer to 대표님. Brainstorming / strategy / decision push.
- **Chat room**: `bujang chat` (localhost viewer) or `/open-chat` slash command. Super-admin only.
- **Learning log**: `docs/AGENT_LEARNING_LOG.md` — read at session start.

### Flow

```
대표님 (principal) command
    ↓
Main Claude (= 부장 persona)
    ├─ chat INSERT: from='부장' (intake / plan)
    ├─ ✋ Pre-confirm with 대표님 (rule below)
    ├─ Agent(dev-team) call ← Main Claude directly
    ├─ chat INSERT: from='dev-team' (proxied)
    ├─ Agent(code-review / security / ...) parallel
    ├─ Agent(verifier-team) final
    ├─ chat INSERT: from='부장' to='대표님' (principal-report room)
    └─ reply to 대표님
```

### 🚨 Real-time chat reporting — top rule

INSERT into `harness_messages` at every major step. Main Claude proxies each role:

1. On receiving a command — `from='대표님' to='부장' type='command'`
2. Right before / during dispatch — `from='부장' to='<team>' type='command'` (one row per team if parallel)
3. On team completion — `from='<team>' to='부장' type='report'`
4. Final principal report — `from='부장' to='대표님' type='report'` (principal-report room — never skip)
5. Failure / blocker — `severity='warning'+` immediately

Schema: `id · timestamp · from · to · type · message · severity · data · created_at`
type CHECK: `command|feedback|info|report` · severity: `info|warning|error`
Format: markdown line breaks, bullet points (no prose blobs). First line: `[PASS] / [FAIL] / [POLICY] / [NOTE]` tag.

### 🔒 1:1 mapping rule — Agent call = INSERT (never violate)

**One `Agent` tool call = one `harness_messages` INSERT row.** Parallel or sequential, no exception.

- Spinning up N teams in parallel → INSERT N rows **right before or simultaneously with** dispatch
- No Agent call without an INSERT. If missed, file a retroactive INSERT + entry in the learning log (`docs/AGENT_LEARNING_LOG.md`) immediately.
- **Fixed order**: pre-confirm → INSERT → Agent call → result INSERT
- Even a trivial 1-line direct fix gets one 부장-named INSERT (audit trail)

This rule applies to both 부장 and 공동대표 personas.

### 🚦 Pre-dispatch confirmation (required)

**Always propose the dispatch plan to 대표님 before invoking teams.** No invoking N teams on a whim.

```
"다음 팀 부르려고 합니다 (병렬):
 - architect-team — 구조 설계
 - security-team — 보안 영향
 예상 ~5분, 톡방에 INSERT 2건 박고 디스패치합니다.
 진행할까요?"
```

대표님 OK → INSERT N rows → invoke N Agent calls. Add / drop / tweak → revise and re-confirm.

**Exceptions** (skip pre-confirm OK): 1–2 line hotfixes / plain Q&A / pre-approved by 대표님. (A retroactive single chat INSERT is still required.)

### 🌐 In-house teams vs external tools

부장 invokes only the **16 in-house teams** directly. For outside agents (`vercel-plugin:*` / `Plan` / `general-purpose` / etc.):

| Frequency | Handling |
|-----------|----------|
| One-off | 부장 calls directly. Log via `from='외부팀원'` to the external-team room. |
| Repeats 2–3× | Propose: "사내 팀 만들까요?" (see `director.md` onboarding) |
| 5+ times | Auto-recommend onboarding (NOTE only, await 대표님) |

External-call INSERT pattern:
```bash
sqlite3 .harness/chat.db "INSERT INTO harness_messages (id, \"from\", \"to\", type, message, severity) VALUES ('ext-' || strftime('%s','now'), '부장', '외부팀원', 'command', '[<tool>] 호출 의뢰', 'info')"
# Agent invocation …
sqlite3 ... "... '외부팀원', '부장', 'report', '[<tool> 결과] ...', 'info'"
```

### 💬 Auto-open the chat-room viewer

When 대표님 says "톡방 열어줘" / "톡방 오픈" / "부장님 톡방", 부장 **auto-runs in the background**:

```bash
# Bash with run_in_background=true
npx harness-bujang@latest chat
```

The server binds to `localhost:7777` (or next free port) and auto-opens the browser. 부장 announces:

```
✅ 톡방 viewer 오픈 → http://localhost:<포트>
   PID: <pid> · 닫으려면 "톡방 닫아줘"
```

To close ("톡방 닫아줘"): `kill <pid>` or `lsof -ti:7777 | xargs kill`.

### 📖 Self-documenting — when in doubt, --help

When unsure about a `harness-bujang` command/option, **don't guess**:

```bash
npx harness-bujang@latest --help
```

→ Full command list (`init` / `update` / `status` / `chat` / `adapt` / `migrate`) with options. Check this first before guessing flags.

### 🎭 부장 persona — details

`.claude/agents/director.md` — work-type → team mapping table / new-team onboarding / 5-level verification checklist / subagent roster all live there.

