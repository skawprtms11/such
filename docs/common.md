# 공통 규약

> 새 화면을 추가하거나 데이터 계층·권한을 건드릴 때 먼저 읽는다.
> 메뉴별 문서: [orders](orders.md) · [status](status.md) · [loading](loading.md) ·
> [inspect](inspect.md) · [issues](issues.md) · [users](users.md)

---

## 0. 웹과 모바일(앱)의 차이 🔑

**모바일(860px 이하)은 앱처럼 쓴다.** 좌측 메뉴와 상단 햄버거 버튼을 감추고
하단 탭바만 남긴다 (`app.css` 의 `@media (max-width: 860px)`).

| | 웹 | 모바일(앱) |
|---|---|---|
| 좌측 메뉴 | 보인다 | **없다** |
| 접근 가능한 메뉴 | 전체 | `MENUS` 의 `mobile: true` 4개 |
| 첫 화면 | 주문정보등록 | **주문처리현황** |

⚠️ **협력사 소속은 기기와 무관하게 앱 메뉴만 쓴다** (`config.js` 의 `appOnlyCompany()`).
PC 로 접속해도 좌측 메뉴에 앱 메뉴 4개만 나오고, 웹 전용 주소로 들어오면 되돌려진다.

- 앱 메뉴는 주문처리현황 · 출고주문처리 · 당일상차리스트 · 이슈등록이다
- 주문정보등록·사용자관리는 웹 전용이다. 모바일에서 그 주소로 들어오면
  `app.js` 의 라우터가 **주문처리현황으로 되돌린다**
- 창 크기가 기준점을 넘나들면 라우터가 다시 판정한다
  (`matchMedia(...).addEventListener('change', render)`)
- 검수 화면(`#/inspect/:id`)은 메뉴가 아니라 당일상차리스트에서 들어가므로 막지 않는다

---

## 1. 화면 모듈 인터페이스

`assets/js/pages/*.js` 는 모두 아래 형태를 지킨다.

```js
export async function render(root, { user, params }) {
    root.innerHTML = `...`;          // 화면 전체를 그린다
    async function reload() { ... }  // 데이터 조회 후 다시 그린다
    await reload();
    return db.subscribe(reload);     // 정리(cleanup) 함수를 반드시 반환
}
```

| 인자 | 설명 |
|---|---|
| `root` | `#view` 엘리먼트. 이 안에만 그린다 |
| `user` | 로그인 사용자 객체 (`id` `name` `role` `company`) |
| `params` | 라우트의 나머지 조각 배열. `#/inspect/o_1001` → `['o_1001']` |

**반환값은 정리 함수다.** 라우터가 화면을 떠날 때 호출한다.
반환하지 않으면 폴링 타이머와 카메라 스트림이 계속 살아 있게 된다.

---

## 2. 라우팅

`assets/js/app.js` 가 해시 기반으로 라우팅한다. 빌드 도구의 SPA 설정이 필요 없다.

```
#/orders            → pages/orders.js
#/inspect/o_1001    → pages/inspect.js  (params = ['o_1001'])
```

- 화면 모듈은 **동적 import** 라서 화면별로 코드가 분할된다. 첫 로딩 시 필요한 것만 받는다
- 알 수 없는 경로는 `#/orders` 로 보낸다
- `adminOnly` 메뉴는 관리자가 아니면 "접근 권한이 없습니다"를 표시한다
- 사이드바/탭바의 활성 표시는 `data-key` 로 맞춘다.
  검수 화면(`inspect`)은 메뉴가 없으므로 `loading` 을 활성으로 표시한다

메뉴를 추가하려면 `config.js` 의 `MENUS` 와 `app.js` 의 `ROUTES` 양쪽에 등록하고,
`icons.js` 에 아이콘도 추가한다.

### 메뉴 정의 (`config.js` 의 `MENUS`)

| 속성 | 설명 |
|---|---|
| `key` | 라우트 키. `ROUTES` 의 키와 같아야 한다 |
| `path` | `#/키` 형태의 해시 경로 |
| `label` | 화면에 표시할 이름 |
| `icon` | `icons.js` 의 아이콘 키 |
| `adminOnly` | true 면 관리자에게만 노출 |
| `mobile` | **true 인 메뉴만 모바일 하단 탭바에 나온다** |

**PC 사이드바에는 모든 메뉴가 나오고, 모바일 탭바에는 `mobile: true` 인 메뉴만 나온다.**
현재 탭바에 노출되는 것은 현장에서 자주 쓰는 3개다.

| 메뉴 | PC 사이드바 | 모바일 탭바 |
|---|:---:|:---:|
| 주문정보등록 | ✅ | ❌ |
| 주문처리현황 | ✅ | ✅ |
| 출고주문처리 | ✅ | ✅ |
| 당일상차리스트 | ✅ | ✅ |
| 이슈등록 | ✅ | ✅ |
| 사용자관리 (관리자) | ✅ | ❌ |

탭바에 없는 메뉴도 **모바일에서 햄버거 버튼(☰)의 서랍으로 접근할 수 있다.**
탭바를 4개 이상으로 늘리면 좁은 화면에서 라벨이 겹치므로 3개를 유지한다.

---

## 3. 데이터 계층 (`db.js` → `store.js`)

화면 코드는 **`db.js` 의 함수만** 호출한다. localStorage 나 Supabase 를 직접 다루지 않는다.

```
pages/*.js  →  db.js  →  store.js  →  localStorage  (VITE_DATA_SOURCE=mock)
              (업무 규칙)  (저장소)  →  Supabase      (VITE_DATA_SOURCE=supabase)
```

**업무 규칙은 `db.js` 한 곳에만 둔다.** 저장소를 바꿔도 규칙은 그대로다.
자세한 동작은 [CLAUDE.md 의 데이터 계층](../CLAUDE.md#5-데이터-계층-) 참고.

### 주문

| 함수 | 설명 |
|---|---|
| `listOrders(filter)` | `from` `to` `shipDate` `keyword` `createdBy` `minStage` 로 필터. 최신순 |
| `getOrder(id)` | 1건 조회 |
| `createOrder(payload, user)` | **차수 자동 계산** + 파렛트 바코드 생성 + 이력 기록 |
| `updateOrder(id, patch, user, memo)` | **변경된 항목마다 이력 기록** |
| `deleteOrder(id, user)` | 주문과 파렛트를 함께 삭제 |
| `setStage(id, stage, user)` | 처리 단계 변경. `stage>=5` 면 `load_status='완료'` |
| `listHistory(orderId)` | 변동사항 이력 (최신순) |

### 상차 · 검수

| 함수 | 설명 |
|---|---|
| `listLoading(shipDate)` | 해당 출고일 + `stage>=4` 인 주문만 |
| `listPallets(orderId)` | 파렛트 바코드 목록 |
| `scanPallet(orderId, barcode, user)` | `{ok, msg, order}` 반환. 전량 스캔 시 `검수` 전환 |
| `resetInspection(orderId, user)` | 검수 전체 초기화 |
| `completeLoading(orderId, user)` | **`검수` 상태에서만 성공.** 아니면 예외 |

### 이슈 · 사용자

`listIssues(filter)` `createIssue` `updateIssue` /
`listUsers` `getUser` `createUser` `updateUserRole` `toggleUserActive`

### 실시간 갱신

```js
return db.subscribe(reload);          // 기본 5초 폴링
return db.subscribe(refresh, 8000);   // 간격 조정 가능
```

mock 은 다른 탭의 `storage` 이벤트 + 폴링, Supabase 는 Realtime 채널을 쓴다.
어느 쪽이든 **화면 코드는 똑같다.**

### 저장소

| 모드 | 저장 위치 | 로그인 |
|---|---|---|
| `mock` | localStorage 키 `tpl_order_db_v1`. 첫 실행 시 `mock-data.js` 시드 적재 | 계정 선택 (임시) |
| `supabase` | Postgres 테이블 6개 (`supabase/schema.sql`) | 이메일 + 비밀번호 |

- `db.resetDb()` 는 **mock 모드에서만** 동작한다. Supabase 는 SQL 로 직접 정리한다
- `db.createUser()` 도 mock 전용이다. Supabase 는 로그인 계정이 함께 필요하다

---

## 4. 권한 판정 (`auth.js`)

```js
import { can } from '../auth.js';

if (can(user, 'download')) { /* 다운로드 버튼 노출 */ }
```

- **역할명을 직접 비교하지 않는다.** `user.role === 'admin'` 같은 코드는 쓰지 않는다
  (예외: `app.js` 의 `adminOnly` 메뉴 필터)
- 권한 항목은 `config.js` 의 `PERMISSION` 에 정의한다
- 조회 범위 제한은 조회 시점에 건다:

```js
const rows = await db.listOrders({
    createdBy: can(user, 'viewAll') ? undefined : user.id,
});
```

### 화면별 정책 (역할 + 소속)

역할만으로 갈리지 않는 화면은 `config.js` 에 정책 객체를 두고 `allow()` 로 판정한다.
현재 주문정보등록 화면이 이 방식을 쓴다 ([orders.md](orders.md#접근-권한) 참고).

```js
import { allow } from '../auth.js';
import { ORDER_POLICY } from '../config.js';

allow(user, ORDER_POLICY.write);   // 역할이 맞거나 소속이 맞으면 true
```

⚠️ 현재는 화면단 제어일 뿐이다. **실제 차단은 Supabase RLS 가 담당한다**
(`supabase/schema.sql` 의 정책 참고). 화면 제어만 믿고 설계하지 않는다.

### 세션

`sessionStorage`(기본) 또는 `localStorage`("로그인 상태 유지")에 사용자 객체를 저장한다.
`requireLogin()` 이 없으면 `index.html` 로 돌려보낸다.

---

## 5. 화면 공통 요소 (`util.js`)

| 함수 | 용도 |
|---|---|
| `esc(s)` | **HTML 이스케이프. 사용자 입력 출력 시 필수** |
| `num(n)` | 천단위 구분자 |
| `today()` `toDateStr(d)` `fmtDateTime(iso)` | 날짜 포맷 |
| `rate(done, total)` | 진행률(%) 정수 |
| `toast(msg, type)` | 안내 메시지. `type`: `info` `success` `error` |
| `openModal(title, html, {wide, footer})` | `{root, body, foot, close}` 반환. `footer` 는 본문 스크롤과 무관하게 항상 보이는 하단 영역 |
| `confirmDialog(msg)` | 확인 대화상자 (Promise) |
| `downloadCsv(name, headers, rows)` | CSV 다운로드. **BOM 포함** — 엑셀 한글 깨짐 방지 |

### 아이콘 (`icons.js`)

메뉴와 버튼 아이콘은 **단색 라인 SVG** 다. 이모지를 쓰지 않는다.

```js
import { icon } from './icons.js';
icon('loading', 'icon tab__icon');   // <svg class="icon tab__icon" ...>
```

- 모든 아이콘은 `stroke="currentColor"` 라서 **놓인 자리의 글자색을 그대로 따른다.**
  남색 사이드바에서는 흰색으로, 흰 배경 탭바에서는 회색(활성 시 파랑)으로 보인다
- 색상을 아이콘 안에 직접 넣지 않는다. 색은 부모의 `color` 로만 정한다
- 크기는 `.icon` 클래스(20px)가 정한다. 다르게 하려면 클래스를 덧붙인다
- 아이콘을 추가하려면 `icons.js` 의 `PATHS` 에 24×24 뷰박스 기준 경로를 넣는다

### 렌더링 규칙

화면은 템플릿 리터럴 + `innerHTML` 로 그린다. 따라서:

```js
// ✅ 올바름
`<td>${esc(o.customer)}</td>`

// ❌ XSS 위험
`<td>${o.customer}</td>`
```

이벤트는 그린 **직후에** 바인딩한다.

```js
tbl.querySelectorAll('[data-edit]').forEach((el) => {
    el.addEventListener('click', () => { /* ... */ });
});
```

다시 그리면 리스너도 함께 사라지므로, `reload()` 안에서 바인딩까지 마쳐야 한다.

---

## 6. 스타일 규약 (`assets/css/app.css`)

| 클래스 | 용도 |
|---|---|
| `.summary` / `.stat` | 상단 요약 카드 4칸 (`.summary--3` 은 3칸) |
| `.card` `.card__head` `.card__body` | 본문 카드 |
| `.toolbar` `.field` | 필터 영역 |
| `.grid` | 표. `.num` 우측정렬, `.center` 가운데, `.wrap` 줄바꿈 허용 |
| `.tag` `.tag--blue/green/amber/red/gray` | 상태 배지 |
| `.steps` `.step` `.is-done` `.is-current` | 처리 단계 배지 |
| `.bar` `.bar__fill` | 진행률 막대 |
| `.btn` `.btn--primary/success/danger/ghost/sm/lg/block` | 버튼 |

### 반응형

- 기준점 **860px**. 이하에서 사이드바가 서랍으로 바뀌고 하단 탭바가 나타난다
- 표는 `.table-wrap` 으로 감싸 가로 스크롤시킨다. **본문이 가로로 밀리면 안 된다**
- 당일상차리스트만 PC는 표(`.load-table`), 모바일은 카드(`.load-list`)로 전환한다.
  두 마크업을 모두 그려두고 CSS 로 감춘다
- 색상은 `:root` 의 CSS 변수를 쓴다. 색상값을 직접 쓰지 않는다

---

## 7. 코딩 규칙

`eslint.config.js` 가 강제한다. `npm run lint` 로 확인.

- 들여쓰기 4칸, 한 줄 100자
- 작은따옴표, 세미콜론 필수, 여러 줄 배열/객체는 마지막 쉼표
- `var` 금지, 재할당 없으면 `const`
- 함수와 모듈에 **한국어 주석**을 붙인다
- `console.log` 금지 (`console.warn` / `console.error` 는 허용)
- 예외는 구체적으로 잡고, 사용자에게는 `toast(err.message, 'error')` 로 알린다
