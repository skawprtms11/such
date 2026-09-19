# 유통가공작업

> 코드 `assets/js/pages/processing.js` + `assets/js/pages/processing/*.js` (웹)
> 모바일 `assets/js/mobile/screens/pcheck.js` (앱 검수 — §17 · [mobile.md](mobile.md#3-8-유통가공-pcheck))
> 순수 계산 `assets/js/processing-calc.js` · 사진 압축 `assets/js/photo.js`
> 라우트 웹 `#/processing` · 앱 `#/pcheck` · [공통 규약](common.md) · [CLAUDE.md](../CLAUDE.md)

창고에서 출고 전에 하는 **유통가공**(라벨 부착 · 세트 구성 · 해체)을 등록하고,
구성품(제품 + 부자재)과 LOT 을 확정해 **작업지시서**를 내는 화면.

주문 흐름(주문정보등록 → 출고주문처리 → 상차리스트)과 **연결되지 않는 독립 업무**다.
주문번호·차수·대표주문번호 개념을 쓰지 않으며, `orders` 테이블을 건드리지 않는다.
(나중에 주문과 잇게 되면 `process_jobs.order_no` 를 추가하는 것이 확장 경로다)

⚠️ **구현 완료 (모바일 검수 §17 포함).** 아래 [열린 가정](#열린-가정) A1~A24 는 **확인을 받지 않은 채 설계안 그대로**
구현했다(부장 지시 범위). 바뀌면 그 표의 「바뀌면 영향」 칸이 고칠 곳이다.
설계안과 다르게 구현한 곳은 [구현 시 바꾼 것](#구현-시-바꾼-것-설계안-대비) 에 근거와 함께 적었다.

---

## 1. 화면 구성

탭 4개짜리 단일 화면이다. 탭 전환·공유 상태·실시간 구독은 셸(`processing.js`)이 맡는다.

| 탭 | 키 | 하는 일 | 상태 |
|---|---|---|---|
| 작업현황 | `jobs` | 작업 등록·수정·삭제, 목록, 작업지시서 생성 | 이번에 구현 |
| 부자재관리 | `material` | 부자재 재고·입출고 | **자리만** (준비 중) |
| 작업캘린더 | `calendar` | 월 달력에 작업 기간 막대 | 이번에 구현 |
| 작업마스터 | `master` | 제품별 구성품(BOM) 등록 | 이번에 구현 |

**웹의 이 4개 탭은 사무 등록 업무라 앱에 넣지 않는다** (`MENUS` 의 `mobile: false`).
대신 **현장 검수만** 앱 탭으로 따로 낸다 — 작업전 검수 · 완료 검수 · 캘린더 3개 세그먼트다.
등록·문서생성은 웹, 사진 증빙은 앱이다 ([§17 모바일 검수](#17-모바일-검수-pcheck-) 참고).

### 파일 구성

| 파일 | 책임 |
|---|---|
| `assets/js/pages/processing.js` | 탭 셸 — 탭 버튼·화면 상태(`state`)·실시간 구독·정리 함수 |
| `assets/js/pages/processing/common.js` | 탭 공용 조각 — 상태 배지·구분 배지·버튼·빈 목록 문구 |
| `assets/js/pages/processing/jobs.js` | 작업현황 탭 — 필터·목록 표·다중 선택·삭제·문서생성 버튼 |
| `assets/js/pages/processing/jobform.js` | 작업 등록·수정 팝업 — 기본정보 + 구성품 표 + LOT 행 편집·검증 |
| `assets/js/pages/processing/calendar.js` | 작업캘린더 탭 — 월 이동·그리드 렌더 (배치는 `processing-calc.js`) |
| `assets/js/pages/processing/master.js` | 작업마스터 탭 — 목록 + 등록·수정 팝업(구성품 표) |
| `assets/js/pages/processing/doc.js` | 작업지시서 인쇄 문서 HTML 생성 + 인쇄창 열기 |
| `assets/js/processing-calc.js` | **순수 함수** — 구성품 전개 · LOT 분할 · 문서번호 · 캘린더 레인 |

분할 기준은 업무체크리스트(`pages/checklist/*`)와 같다 — 셸은 탭만 알고,
탭 모듈은 `drawXxx({ state, body, user, reload })` 형태의 함수 하나를 export 한다.

**순수 함수를 `assets/js/processing-calc.js` 로 뺀다** (판단 근거):
`checkflow.js` 선례가 있고, 캘린더 레인 배치와 LOT 분할은 불변식이 있는 계산이라
`tools/processing-check.js` 로 랜덤 입력 검증을 붙일 수 있다
(업무프로세스 도식이 문서에만 적어 둔 불변식을 두 번 깬 전례 —
[AGENT_LEARNING_LOG 2026-09-17](AGENT_LEARNING_LOG.md)).
DOM·저장소를 모르는 함수만 넣는다.

---

## 2. 메뉴 등록

### `config.js` 의 `MENUS`

```js
{ key: 'processing', path: '#/processing', label: '유통가공작업',
  icon: 'processing', mobile: false },
```

위치는 `loading`(상차리스트) 뒤 · `issues`(이슈등록) 앞. 창고 작업 메뉴끼리 모은다.

### `app.js` 의 `ROUTES`

```js
processing: () => import('./pages/processing.js'),
```

`mobile: false` 라서 좁은 화면·협력사 소속은 `app.js` 의 기존 가드가 자동으로 막는다.
별도 처리가 필요 없다.

### `icons.js`

새 아이콘 키 **`processing`** 을 `PATHS` 에 추가한다 (24×24 뷰박스, `stroke="currentColor"`).
그림: 상자 + 라벨 한 장(사각형 + 작은 태그). 기존 `orders`·`stow` 와 구분되게 그린다.

### 다른 문서 갱신 (doc-sync-team 몫)

1. `CLAUDE.md` 메뉴 표에 행 추가
   `| 유통가공작업 | docs/processing.md | assets/js/pages/processing.js | #/processing | — (앱에 없음) |`
2. `CLAUDE.md` 폴더 구조의 `pages/` 아래에 `processing/` 한 줄 +
   `assets/js/` 아래에 `processing-calc.js` 한 줄
3. `CLAUDE.md` 데이터 모델 표에 4행 추가 (아래 §3 참고)
4. `CLAUDE.md` 권한 표에 `manageProcessing` 행 추가
5. `docs/common.md` 의 메뉴별 문서 링크 · `MENUS`/`mobile` 표에 행 추가

---

## 3. 데이터 모델

mock(localStorage)과 Supabase가 **같은 필드명**을 쓴다. 정식 정의는 `supabase/schema.sql`.

### `process_masters` — 작업마스터 (제품 1건)

| 컬럼 | 타입 | 제약 | 설명 |
|---|---|---|---|
| `id` | text | pk | `uid('pm')` |
| `work_type` | text | not null, check | 작업구분 `라벨`/`해체`/`세트` |
| `product_code` | text | not null | 제품코드 |
| `product_name` | text | not null | 제품명 |
| `created_by` | uuid | fk profiles | 등록자 |
| `created_by_name` | text | not null default '' | |
| `created_at` | timestamptz | not null default now() | |
| `updated_at` | timestamptz | | 수정 시각 (db.js 가 넣는다) |
| `deleted_at` | timestamptz | | soft delete |

🔑 **`unique(product_code) where deleted_at is null`** — 살아 있는 마스터는 제품코드당 1건.
작업 등록 폼이 **제품코드만으로** 마스터를 찾기 때문이다(작업구분 입력칸이 없다).
같은 제품에 작업구분이 여러 개 필요해지면 ① 작업 등록 폼에 작업구분 선택을 추가하고
② 제약을 `unique(product_code, work_type)` 로 넓히는 것이 확장 경로다.

### `process_master_items` — 마스터 구성품

| 컬럼 | 타입 | 제약 | 설명 |
|---|---|---|---|
| `id` | text | pk | `uid('pmi')` |
| `master_id` | text | not null, fk → masters, on delete cascade | |
| `kind` | text | not null, check | `제품` / `부자재` |
| `code` | text | not null default '' | 코드. **부자재는 비어 있을 수 있다** |
| `name` | text | not null | 품목명 |
| `qty_per` | integer | not null, check > 0 | 작업 1개당 필요수량 |
| `sort_order` | integer | not null default 0 | 표시 순서 |

### `process_jobs` — 작업

| 컬럼 | 타입 | 제약 | 설명 |
|---|---|---|---|
| `id` | text | pk | `uid('pj')` |
| `doc_no` | text | **unique**, null 허용 | 작업지시서 문서번호 `YYYYMMDD-NN` |
| `master_id` | text | fk → masters, **on delete set null** | 만들 때 쓴 마스터 (참고용. 하드 삭제돼도 작업은 산다 — 구성품은 스냅샷이다) |
| `work_type` | text | not null | 마스터의 작업구분 **스냅샷** |
| `product_code` | text | not null | |
| `product_name` | text | not null | |
| `qty` | integer | not null, check > 0 | 작업수량 |
| `start_date` | date | not null | 시작예정일 |
| `due_date` | date | not null, check ≥ start_date | 완료요청일 |
| `doc_created_at` | timestamptz | | 문서 생성 시각. **상태를 바꾸지 않는다**(§8 개정) |
| `doc_created_by` / `_name` | uuid / text | | 문서를 낸 사람 |
| `pre_check_at` | timestamptz | | **작업전 검수 완료 시각 (`작업중` 판정)** — 앱에서만 찍힌다 |
| `pre_check_by` / `_name` | uuid / text | | 작업전 검수자 |
| `done_at` | timestamptz | | **완료 검수 시각 (`작업완료` 판정)** — 앱에서만 찍힌다 |
| `done_by` / `_name` | uuid / text | | 완료 검수자 |
| `created_by` / `_name` | uuid / text | | 등록자 |
| `created_at` `updated_at` `deleted_at` | timestamptz | | soft delete |

### `process_job_items` — 작업 구성품 스냅샷 + LOT 행

| 컬럼 | 타입 | 제약 | 설명 |
|---|---|---|---|
| `id` | text | pk | `uid('pji')` |
| `job_id` | text | not null, fk → jobs, on delete cascade | |
| `line_no` | integer | not null | **구성품 줄 번호.** 같은 구성품의 LOT 행들을 묶는다 |
| `kind` | text | not null, check | `제품` / `부자재` |
| `code` | text | not null default '' | |
| `name` | text | not null | |
| `qty_per` | integer | not null, check > 0 | 마스터 필요수량 **스냅샷** |
| `lot` | text | not null default '' | LOT. 제품 행만 쓴다 |
| `qty` | integer | not null, check > 0 | 이 행의 수량 |
| `sort_order` | integer | not null default 0 | 같은 `line_no` 안의 행 순서 |

### `process_photos` — 검수 사진 메타 (§17)

사진 **파일은 Storage**(버킷 `process-photos`)에, **메타만** 이 테이블에 둔다.

| 컬럼 | 타입 | 제약 | 설명 |
|---|---|---|---|
| `id` | text | pk | `uid('pp')` |
| `job_id` | text | not null, fk → jobs, on delete cascade | |
| `phase` | text | not null, check `pre`/`done` | 작업전 검수 / 완료 검수 |
| `line_no` | integer | **작업전은 구성품 줄 번호 · 완료는 null** | `process_job_items.line_no` 와 같은 번호 |
| `seq` | integer | not null default 1 | 완료 검수의 1·2·3. 작업전은 언제나 1 |
| `path` | text | not null | Storage 경로 `jobs/{job_id}/{phase}/{line_no or seq}.jpg` |
| `size` | integer | not null default 0 | 압축 후 바이트 |
| `taken_by` / `_name` | uuid / text | | 촬영·저장한 사람 |
| `taken_at` | timestamptz | not null | |

🔑 **슬롯 규칙은 서버 CHECK(`process_photos_slot_chk`)로도 못 박혀 있다** —
작업전은 `line_no > 0` 이고 `seq = 1`, 완료는 `line_no` 가 없고 `seq` 는 1~3 이다.
`unique` 는 중복만 막을 뿐 `phase` 와 슬롯 키가 어긋난 행은 그냥 받아 준다 (§5-1 참고).

🔑 **`unique(job_id, phase, coalesce(line_no, -1), seq)`.** 재촬영·재저장은 **같은 행을 update**
하고 같은 경로를 덮어쓴다. 새 행을 만들면 unique 에 걸리고 Storage 에 고아 파일이 쌓인다
(`db.savePreCheck` 가 기존 행을 먼저 찾는 이유다). `line_no` 가 null 이라 `coalesce` 를 쓴다 —
null 이 섞인 unique 는 중복을 막지 못한다.

#### 스냅샷을 두는 이유 🔑

마스터는 언제든 바뀐다(라벨 규격 변경·부자재 교체). 작업에 구성품을 **복사해 두지 않으면**
어제 인쇄해 현장에 내려보낸 작업지시서를 오늘 다시 뽑았을 때 내용이 달라진다.
문서번호는 같은데 내용이 다른 종이가 두 장 도는 것은 현장 사고다.
그래서 `process_job_items` 는 마스터를 **참조하지 않고 값을 복사**하고,
`work_type` 도 작업에 복사한다. 마스터를 지워도 작업지시서는 그대로 재출력된다.

#### 골격에서 바꾼 것 두 가지 (근거 포함)

**① `need_qty` 컬럼을 두지 않는다.** 필요수량은 언제나 `qty_per × job.qty` 다.
같은 값을 두 곳에 저장하면 반드시 어긋난다(작업수량 수정·부분 저장 실패 시).
계산은 `processing-calc.js` 의 `needQty(qty_per, jobQty)` 한 곳에서만 한다.
*Tradeoff*: SQL 로 바로 집계할 수 없다 — 부자재 소요량 집계가 필요해지면
뷰(`create view process_job_need`)를 추가한다. 컬럼을 늘리지는 않는다.

**② `status` 컬럼을 두지 않고 계산한다.** 이 프로젝트는 처리 단계를 **완료 시각 필드**로
표현하고 숫자·문자열 상태 저장을 폐기했다(CLAUDE.md 핵심개념 1). 같은 원칙을 따른다.

```
done_at 있음        → 완료
doc_created_at 있음 → 진행
그 밖              → 대기
```

판정은 **`db.processStatus(job)` 한 곳**에만 둔다(화면이 다시 계산하지 않는다 —
같은 판정을 화면마다 새로 짜서 모집단이 갈린 전례가 있다).
*Tradeoff*: `보류`·`취소` 같은 흐름 밖 상태가 생기면 시각 필드만으로는 표현할 수 없다.
그때는 `canceled_at` 을 추가한다(주문의 `canceled_at` 과 같은 방식).

### `config.js` 상수 (유일한 출처)

```js
/** 유통가공 작업구분 */
export const PROCESS_WORK_TYPE = { LABEL: '라벨', DISMANTLE: '해체', SET: '세트' };
export const PROCESS_WORK_TYPES = Object.values(PROCESS_WORK_TYPE);

/** 구성품 구분 */
export const PROCESS_ITEM_KIND = { PRODUCT: '제품', MATERIAL: '부자재' };
export const PROCESS_ITEM_KINDS = Object.values(PROCESS_ITEM_KIND);

/** 진행상태 - 저장하지 않고 계산한다 (db.processStatus) */
export const PROCESS_STATUS = { WAIT: '작업대기', DOING: '작업중', DONE: '작업완료' };
export const PROCESS_STATUSES = Object.values(PROCESS_STATUS);

/** 진행상태 색 - 웹 `.tag--*` `.pc-bar--*` 와 앱 `tag()` tone 이 **같은 값**을 쓴다 */
export const PROCESS_STATUS_TONE = {
    [PROCESS_STATUS.WAIT]: 'gray',
    [PROCESS_STATUS.DOING]: 'blue',
    [PROCESS_STATUS.DONE]: 'green',
};

/** 검수 단계 키 (process_photos.phase) */
export const PROCESS_PHASE = { PRE: 'pre', DONE: 'done' };
/** 완료 검수 사진 장수 - 정확히 이 수만 받는다 */
export const PROCESS_DONE_PHOTOS = 3;
```

🔑 **색 토큰은 `PROCESS_STATUS_TONE` 하나뿐이다.** 웹은 `statusTone()` 으로 `.tag--gray`
`.pc-bar--blue` 를, 앱은 같은 값을 `ui.js` 의 `tag(label, tone)` 에 그대로 넘긴다.
화면마다 색을 정하면 같은 상태가 웹·앱에서 다른 색으로 보인다.

화면 코드에 `'제품'` `'대기'` 같은 문자열을 직접 쓰지 않는다.

---

## 4. `store.js` 변경점

`TABLES` 에 네 항목을 추가한다. `cols` 는 화이트리스트라 여기 없는 값은 서버로 가지 않는다.

```js
{
    key: 'processMasters',
    name: 'process_masters',
    cols: [
        'id', 'work_type', 'product_code', 'product_name',
        'created_by', 'created_by_name', 'created_at', 'updated_at', 'deleted_at',
    ],
},
{
    key: 'processMasterItems',
    name: 'process_master_items',
    cols: ['id', 'master_id', 'kind', 'code', 'name', 'qty_per', 'sort_order'],
},
{
    key: 'processJobs',
    name: 'process_jobs',
    cols: [
        'id', 'doc_no', 'master_id', 'work_type', 'product_code', 'product_name',
        'qty', 'start_date', 'due_date',
        'doc_created_at', 'doc_created_by', 'doc_created_by_name', 'done_at',
        'created_by', 'created_by_name', 'created_at', 'updated_at', 'deleted_at',
    ],
},
{
    key: 'processJobItems',
    name: 'process_job_items',
    cols: ['id', 'job_id', 'line_no', 'kind', 'code', 'name', 'qty_per', 'lot', 'qty', 'sort_order'],
},
```

```js
// 모바일 검수 (§17)
{
    key: 'processPhotos',
    name: 'process_photos',
    cols: [
        'id', 'job_id', 'phase', 'line_no', 'seq', 'path', 'size',
        'taken_by', 'taken_by_name', 'taken_at',
    ],
},
```

### 파일 저장 API 🔑 (§17 에서 추가)

사진 **바이너리는 행 diff 엔진을 타지 않는다.** `store.js` 에 파일 전용 API 3개를 둔다 —
`db.js` 만 이것을 부르고, 화면은 여전히 `db.*` 만 부른다.

| 함수 | mock | supabase |
|---|---|---|
| `putFile(path, blob)` | IndexedDB `tpl_files/files` 에 Blob 저장 | `storage.from('process-photos').upload(path, blob, { upsert: true })` |
| `fileUrls(paths)` → `{ urls: Map, release() }` | `URL.createObjectURL` · `release()` 가 revoke | `createSignedUrls(paths, 600)` · `release()` 는 no-op |

- 🔑 **지우는 API 는 두지 않는다.** 검수 취소도 사진을 남기고(A22) 경로가 결정적이라 재촬영이
  덮어쓰므로 부를 곳이 없었다. 쓰는 곳 없는 삭제 API 는 「언젠가 쓰겠지」 로 남았다가
  권한 검사 없이 불리는 자리가 된다. 고아 파일 정리는 아래 [열린 이슈](#열린-이슈-사진) 참고

- ⚠️ **mock 모드에서 사진을 localStorage 에 넣지 않는다.** 압축해도 장당 150~200KB 라
  한도(5MB)가 작업 5~6건이면 찬다. 그때 `setItem` 이 `QuotaExceededError` 를 던지는데
  `saveDb` 는 **전체 JSON 을 한 번에** 쓰므로 사진뿐 아니라 **주문·체크리스트까지 저장이 막힌다.**
  그래서 파일만 IndexedDB(`assets/js/idb.js`)로 뺀다 — 용량이 수백 MB 단위이고 Blob 을
  그대로 담아 base64 로 33% 부풀지도 않는다
- `fileUrls` 가 **Map 과 `release()` 를 함께** 돌려주는 이유: mock 의 objectURL 은 화면을
  떠날 때 revoke 하지 않으면 샌다. 두 모드의 뒷정리 모양을 같게 해 화면 코드가
  저장소를 알지 못하게 한다 (`render()` 의 정리 함수에서 `release()` 를 부른다)

- mock 초기 구조(`mockLoad()` 의 `empty`)에 네 키를 빈 배열로 추가한다
- `db.js` 의 `normalize()` 에도 `db.processMasters = db.processMasters ?? []` … **다섯** 줄을 넣는다
  (옛 저장 데이터를 열어도 오류가 나지 않게 한다)
- Realtime 구독은 `subscribeStore` 가 `TABLES` 를 돌며 자동으로 붙는다. 추가 작업 없음
- 🔑 **`pushChanges` 는 수정·삭제 결과를 `.select('id')` 로 되읽어 0행을 잡는다.**
  RLS 에 막힌 쓰기는 오류가 아니라 「0행」으로 돌아오고 PostgREST 는 그것을 성공으로 준다.
  그대로 두면 화면은 「저장됐습니다」 인데 서버 값은 그대로다 (현장작업자의 유통가공 검수가
  실제로 그랬다 — §5-1 🔴). `TABLES` 의 **`scopedSelect`** 는 select 정책이 「로그인 사용자
  전부」보다 좁아 **쓰기가 성공해도 되읽기가 0행일 수 있는** 테이블이라 이 검사에서 뺀다
  (`orders` `order_history` `pallets` `restore_requests` `issues` `issue_comments` 6개).
  유통가공 5개 테이블은 전부 조회가 열려 있어 검사 대상이다
- ⚠️ `store.js` 는 **테이블 전체를 매번 읽는다.** 작업 1건이 구성품 행 수십 개를 만들므로
  `process_job_items` 가 가장 빨리 커진다. 운영 6개월치를 넘기면 전체 읽기가 부담이 되니
  그때는 이 테이블만 기간 조건 조회로 빼는 것을 검토한다 (지금은 넣지 않는다)

---

## 5. `supabase/schema.sql` 초안

기존 checklist 테이블 패턴을 그대로 따른다 — `id text`, `create table if not exists`,
`updated_at` 은 **트리거를 쓰지 않고 `db.js` 가 채운다**(설계 메모 2: 업무 규칙을 트리거에 넣지 않는다).

```sql
-- ─────────────────────── 유통가공 작업마스터 (process_masters) ───────────────────────
-- 제품 1건의 유통가공 구성(BOM). 작업 등록 시 제품코드로 찾아 구성품을 펼친다.
-- 살아 있는 마스터는 제품코드당 1건이다 (작업 등록 폼에 작업구분 입력칸이 없다).
create table if not exists public.process_masters (
    id              text        primary key,
    work_type       text        not null check (work_type in ('라벨', '해체', '세트')),
    product_code    text        not null,
    product_name    text        not null,
    created_by      uuid        references public.profiles (id),
    created_by_name text        not null default '',
    created_at      timestamptz not null default now(),
    updated_at      timestamptz,
    deleted_at      timestamptz
);
create unique index if not exists process_masters_code_uidx
    on public.process_masters (product_code) where deleted_at is null;

create table if not exists public.process_master_items (
    id         text     primary key,
    master_id  text     not null references public.process_masters (id) on delete cascade,
    kind       text     not null check (kind in ('제품', '부자재')),
    code       text     not null default '',     -- 부자재는 코드가 없을 수 있다
    name       text     not null,
    qty_per    integer  not null check (qty_per > 0),
    sort_order integer  not null default 0
);
create index if not exists process_master_items_master_idx
    on public.process_master_items (master_id, sort_order);

-- ─────────────────────── 유통가공 작업 (process_jobs) ───────────────────────
-- 진행상태는 저장하지 않는다. done_at → 완료, doc_created_at → 진행, 없으면 대기.
-- 문서번호는 한 번 나가면 고정이고 재생성하지 않는다 (unique 가 최후 방어선).
create table if not exists public.process_jobs (
    id                  text        primary key,
    doc_no              text        unique,
    master_id           text        references public.process_masters (id),
    work_type           text        not null,          -- 마스터 값 스냅샷
    product_code        text        not null,
    product_name        text        not null,
    qty                 integer     not null check (qty > 0),
    start_date          date        not null,
    due_date            date        not null,
    doc_created_at      timestamptz,
    doc_created_by      uuid        references public.profiles (id),
    doc_created_by_name text        not null default '',
    done_at             timestamptz,
    created_by          uuid        references public.profiles (id),
    created_by_name     text        not null default '',
    created_at          timestamptz not null default now(),
    updated_at          timestamptz,
    deleted_at          timestamptz,
    check (due_date >= start_date)
);
create index if not exists process_jobs_date_idx on public.process_jobs (start_date, due_date);
create index if not exists process_jobs_code_idx on public.process_jobs (product_code);

-- 구성품 스냅샷 + LOT 행. line_no 가 같은 행들이 구성품 한 줄이다.
create table if not exists public.process_job_items (
    id         text     primary key,
    job_id     text     not null references public.process_jobs (id) on delete cascade,
    line_no    integer  not null,
    kind       text     not null check (kind in ('제품', '부자재')),
    code       text     not null default '',
    name       text     not null,
    qty_per    integer  not null check (qty_per > 0),
    lot        text     not null default '',
    qty        integer  not null check (qty > 0),
    sort_order integer  not null default 0
);
create index if not exists process_job_items_job_idx
    on public.process_job_items (job_id, line_no, sort_order);

-- ── 권한 판정 함수 (config.js 의 manageProcessing 과 같아야 한다) ──
create or replace function public.can_manage_processing()
    returns boolean language sql stable as $$
    select public.my_role() in ('admin', 'yongma', 'shipper_admin')
$$;

-- ── RLS ──
alter table public.process_masters      enable row level security;
alter table public.process_master_items enable row level security;
alter table public.process_jobs         enable row level security;
alter table public.process_job_items    enable row level security;

-- 조회는 로그인 사용자 모두 (창고 내부 업무라 등록자 제한을 두지 않는다)
drop policy if exists process_masters_select on public.process_masters;
create policy process_masters_select on public.process_masters for select to authenticated
    using (true);
drop policy if exists process_masters_insert on public.process_masters;
create policy process_masters_insert on public.process_masters for insert to authenticated
    with check (public.can_manage_processing() and created_by = auth.uid());
drop policy if exists process_masters_update on public.process_masters;
create policy process_masters_update on public.process_masters for update to authenticated
    using (public.can_manage_processing()) with check (public.can_manage_processing());
drop policy if exists process_masters_delete on public.process_masters;
create policy process_masters_delete on public.process_masters for delete to authenticated
    using (public.can_manage_processing());
-- (process_master_items · process_jobs · process_job_items 도 같은 4정책을 붙인다.
--  jobs 의 insert 만 `created_by = auth.uid()` 를 함께 본다)
```

### 5-1. 모바일 검수 마이그레이션 (§17) — **멱등**

이미 만들어진 테이블에 덧붙인다. 전부 `if not exists` / `create or replace` / `drop policy
if exists` 라 **몇 번을 돌려도 같은 결과**다.

🔑 **SQL 전문을 이 문서에 옮겨 적지 않는다.** 원본은 `supabase/schema.sql` 의
「유통가공 모바일 검수」 블록 하나뿐이고, 실행용 초안은 그 블록을 그대로 복사한
`20260919_processing_mobile.sql` 이다. 문서까지 세 벌이 되면 한 벌만 고치는 날이 온다.
고칠 때는 **schema.sql 을 먼저 고치고 초안을 다시 만든 뒤 `diff` 로 0 을 확인**한다.

이 블록이 하는 일은 여섯 가지다.

| # | 하는 일 | 왜 |
|---|---|---|
| 1 | `process_jobs` 에 검수 컬럼 5개 (`pre_check_at` `pre_check_by(_name)` `done_by(_name)`) | 상태를 움직이는 시각 |
| 2 | `process_photos` 테이블 + **슬롯 CHECK** + 슬롯 unique | 아래 참고 |
| 3 | **`process_jobs_update` 정책을 `updateStatus` 까지 열고** `trg_enforce_process_check_cols` 로 컬럼을 좁힘 | 아래 🔴 |
| 4 | Storage 버킷 `process-photos` (private · 1MB · JPEG) | 사진 파일 |
| 5 | `storage.objects` 정책 4개 (**경로까지 강제**) | 아래 🔑 |
| 6 | Realtime publication 등록 (멱등 가드) | 실시간 갱신 |

#### 🔴 검수가 상태를 못 찍던 구멍 (DB 감사 · 2026-09-19)

`process_jobs_update` 가 `can_manage_processing()` 뿐이라 **현장작업자(worker)의
`pre_check_at`·`done_at` UPDATE 가 0행으로 조용히 실패**했다. PostgREST 는 RLS 가 거른
0행을 오류로 주지 않으므로 앱은 「검수를 완료했습니다」 를 띄우고 서버 값은 그대로였다.
(mock 모드로만 확인해서 발견이 늦었다 — 실서버에서 검수 전체가 동작하지 않았을 자리다)

```sql
using / with check (public.can_manage_processing() or public.can_update_status())
```

넓힌 만큼 **트리거가 컬럼을 좁힌다.** `enforce_process_check_cols()` 는 등록 권한자면
그대로 통과시키고, 검수 권한만 있는 사용자에게는 **검수 6컬럼 + `updated_at` 을 `old` 로
되돌린 사본이 `old` 와 같은지**(`probe is distinct from old`) 확인한다. 하나라도 다르면
`검수 권한으로는 검수 항목만 수정할 수 있습니다.` 로 막는다. 컬럼을 나열해 비교하면
컬럼이 늘 때마다 여기를 고쳐야 하지만, 이 방식은 **새 컬럼이 자동으로 「못 고치는 쪽」**이 된다.

- 클라이언트 짝은 `store.js` 의 `pushChanges` 다 — 이제 `.select('id')` 로 되읽어 0행이면
  오류를 던진다(§4). 서버가 막는 것과 화면이 아는 것이 같아진다

#### 슬롯 CHECK 🔑 (`process_photos_slot_chk`)

```sql
seq > 0 and (
    (phase = 'pre'  and line_no is not null and line_no > 0 and seq = 1)
 or (phase = 'done' and line_no is null)
)
```

`unique(job_id, phase, coalesce(line_no, -1), seq)` 는 **중복만** 막고, `phase` 와 슬롯 키가
어긋난 행(작업전인데 `line_no` 없음 · 완료인데 `line_no` 있음)은 그대로 들어간다. 그러면
`coalesce(line_no, -1)` 이 헛돌아 같은 자리에 행이 둘 생긴다.
`db.js` 의 `commitPhotos` 가 넣는 값과 정확히 같은 규칙이고, `photoLines()` 도
`line_no > 0` 만 슬롯으로 인정해 **「저장은 되는데 서버가 거부」 하는 경로**를 만들지 않는다.

- `process_photos_job_idx`(job_id, phase) 는 **만들지 않는다.** 위 unique 의 선두 두 컬럼과
  겹쳐 읽기에 보탬이 없고 쓰기만 느려진다 (있으면 `drop index if exists` 로 지운다)

#### 🔑 Storage 경로를 정책에서 강제한다 (보안 감사)

`bucket_id` 와 권한만 보면 **검수 권한자가 `jobs/…` 밖이나 없는 작업 아래에 아무 파일이나**
올려 버킷을 개인 저장소로 쓸 수 있다. 경로를 만드는 곳은 `db.js` 의 `photoPath` 하나
(`jobs/{job_id}/{phase}/{slot}.jpg`)뿐이라, 서버가 같은 모양을 요구해도 정상 경로는 막히지 않는다.

```sql
and (storage.foldername(name))[1] = 'jobs'
and exists (select 1 from public.process_jobs j
            where j.id = (storage.foldername(name))[2] and j.deleted_at is null)
```

`storage.foldername(name)` 은 **파일명을 뺀 폴더 배열**이고 Postgres 배열은 1부터다 —
`jobs/pj_x/pre/1.jpg` → `{jobs, pj_x, pre}`. insert 와 update **둘 다**에 건다
(`upsert: true` 는 UPDATE 를 타므로 insert 만 막으면 재촬영으로 우회된다).

#### 그 밖의 잠금

- ⚠️ `file_size_limit` 은 **압축 목표(200KB)의 5배**로 잡았다. 목표를 못 맞춘 사진(도장·라벨이
  많은 화면은 JPEG 가 잘 안 줄어든다)도 통과시키되, 원본(3~8MB)은 확실히 막는다
- `process_photos_update` 의 `with check` 에 **`taken_by = auth.uid()`** 를 넣었다.
  재촬영으로 **증빙의 명의를 바꿔치기** 하는 길을 막는다
- ⚠️ **읽기를 「버킷 전체」로 둔 것은 버킷이 private 이기 때문이다.** 서명 URL 발급도 이 정책을
  탄다. 공개 버킷으로 바꾸면 주소만 알면 누구나 보게 되므로 바꾸지 않는다
- `update` 정책이 꼭 필요하다 — **재촬영이 같은 경로를 덮어쓴다**(`upsert: true` 는
  내부적으로 UPDATE 를 탄다). insert 만 열면 재촬영이 조용히 실패한다
- ⚠️ **`alter table storage.objects enable row level security` 는 넣지 않는다.** 이 테이블은
  `supabase_storage_admin` 소유라 소유자 오류가 나고, Supabase 가 이미 켜 두었다.
  정책 생성에서도 소유자 오류가 나면 Dashboard → Storage → Policies 에서 같은 식으로 만든다

### 문서번호 동시성 🔑

채번은 `db.js` 가 한다 — `그 날짜 prefix 의 doc_no 중 최대 순번 + 1`.
두 사람이 같은 순간에 「생성」을 누르면 같은 번호가 나올 수 있다. 막는 장치는 두 겹이다.

1. **`unique(doc_no)`** — 서버가 두 번째 INSERT/UPDATE 를 거부한다. 최후 방어선
2. **충돌 시 재시도** — `store.js` 가 던지는 오류 메시지에 `duplicate`/`unique` 가 있으면
   `invalidate()` 후 다시 읽어 번호를 새로 매기고 **최대 5회** 재시도한다.
   5회 모두 실패하면 `toast('문서번호 채번에 실패했습니다. 다시 시도해 주세요.', 'error')`

DB 함수(`next_process_doc_no()`)나 시퀀스를 쓰지 않는 이유: 업무 규칙을 서버와 `db.js`
양쪽에 두면 mock 모드와 규칙이 갈린다(설계 메모 2). 하루 생성량이 수십 건 수준이라
낙관적 재시도로 충분하다. 생성량이 분당 수십 건이 되면 그때 RPC 로 옮긴다.

---

## 6. `db.js` 함수 시그니처

**업무 규칙은 여기 한 곳에만 둔다.** 화면은 `db.*` 만 부른다.

### 마스터

| 함수 | 설명 |
|---|---|
| `listProcessMasters(f = {})` | 살아 있는 마스터 목록. `f.keyword`(코드·품명) `f.workType`. 구성품 수(`item_count`)를 붙여 준다 |
| `getProcessMaster(id)` | `{ master, items }` — `items` 는 `sort_order` 순 |
| `findProcessMasterByCode(code)` | `{ master, items }` 또는 `null` — 작업 등록 폼이 제품코드로 찾는다 |
| `createProcessMaster(payload, user)` | `payload {work_type, product_code, product_name, items:[{kind, code, name, qty_per}]}`. 제품코드 중복·구성품 0건·`qty_per ≤ 0` 을 거부 |
| `updateProcessMaster(id, patch, user)` | 구성품은 **통째로 교체**(기존 행 삭제 후 재생성). 이미 만들어진 작업에는 영향 없다(스냅샷) |
| `deleteProcessMaster(id, user)` | soft delete. 이 마스터로 만든 작업이 있어도 막지 않는다 |

### 작업

| 함수 | 설명 |
|---|---|
| `listProcessJobs(f = {})` | `f.from` `f.to`(시작예정일 범위) `f.status` `f.keyword`(문서번호·제품코드·제품명). 최신순. 각 행에 `status`(계산값)를 붙인다 |
| `getProcessJob(id)` | `{ job, items }` — `items` 는 `line_no` → `sort_order` 순 |
| `createProcessJob(payload, user)` | `payload {product_code, qty, start_date, due_date, items:[{line_no, lot, qty}]}`. 마스터 존재·LOT 합계·날짜 순서를 **다시 검증**하고 `work_type` `product_name` `master_id` 를 채운다. **제품 줄의 LOT 행이 하나도 없으면 거부**한다(§10) |
| `updateProcessJob(id, patch, user)` | 문서번호가 있으면 `start_date` `due_date` 만 받는다(§9). 완료된 건은 거부. **작업수량·제품코드가 바뀌는데 `patch.items` 가 없으면 거부**하고, 둘 다 그대로면 기존 구성품을 지킨 채 일정만 고친다(§11) |
| `deleteProcessJobs(ids, user)` | 다중 soft delete. **완료된 건이 섞여 있으면 전부 거부**하고 사유를 던진다 |
| ~~`setProcessDone(id, user)`~~ | **삭제**(§8 개정). 완료는 앱 `saveDoneCheck` 로만 |
| `issueProcessDoc(id, user)` | **문서번호 채번 + `doc_created_at` 기록.** 이미 번호가 있으면 그대로 돌려준다(재생성 없음). 충돌 시 재시도 |
| `processStatus(job)` | `작업대기`/`작업중`/`작업완료` — **판정의 유일한 출처** (§8) |
| `canManageProcessing(user)` | `PERMISSION[role].manageProcessing` — 등록·수정·삭제·문서생성 |

### 모바일 검수 (§17)

| 함수 | 설명 |
|---|---|
| `canCheckProcessing(user)` | `can(user, 'updateStatus')` — **검수 권한 판정의 유일한 출처** |
| `listProcessJobsForCheck(phase, f = {})` | `phase='pre'` → `doc_no` 있고 `pre_check_at` 없는 건 / `'done'` → `pre_check_at` 있고 `done_at` 없는 건. `f.keyword`(문서번호·제품코드·제품명). 시작예정일 ↑ 정렬. 각 행에 `status` · `photo_count` |
| `findProcessJobByDocNo(docNo)` | 문서번호 정확 일치 1건 → `{ job, items }` 또는 `null`. **주문번호는 보지 않는다** |
| `savePreCheck(jobId, photos, user)` | `photos: [{ line_no, blob }]` — **이번에 찍은 것만**. 업로드 → `process_photos` upsert (커밋 지점 ①). **이미 `pre_check_at` 인 건은 거부**(취소 후 재촬영) |
| `completePreCheck(jobId, user)` | 저장된 메타가 구성품 줄을 모두 덮으면 `pre_check_at` 기록 (커밋 지점 ② · 상태가 바뀐다). **구성품 0줄은 거부** — 「빠진 줄 없음」이 늘 참이 되어 사진 없이 통과한다 |
| `saveDoneCheck(jobId, photos, user)` | `photos: [{ seq, blob }]` — 슬롯은 1~`PROCESS_DONE_PHOTOS` |
| `completeDoneCheck(jobId, user)` | 메타가 **정확히 3칸**이면 `done_at` 기록. `pre_check_at` 없는 작업은 거부 |
| `revokePreCheck(jobId, user)` / `revokeProcessDone(jobId, user)` | 시각만 지운다. **사진은 지우지 않는다**(다시 찍으면 같은 경로를 덮어쓴다) |
| `listProcessPhotos(jobId, phase)` | 메타 행 (`line_no` → `seq` 순) |
| `processPhotoUrls(paths)` | → `{ urls: Map<path,string>, release() }` — 화면은 `release()` 를 정리 함수에서 부른다 |

🔑 **저장과 커밋을 함수로도 나눈 이유** — §17-4 의 커밋 지점이 「저장」·「검수완료」 둘인데
함수가 하나면 「저장」만 눌러도 상태가 바뀐다. 설계안의 `savePreCheck` 한 줄을
`save*` + `complete*` 로 가른 것이고, 검증은 양쪽에 그대로 들어 있다.

**검증은 전부 `db.js` 에 둔다** (화면이 잠근 조건을 db 도 똑같이 막는다).

| 규칙 | 거부 문구 |
|---|---|
| 권한 없음 | `유통가공 검수 권한이 없습니다.` |
| 작업 없음·삭제됨 | `작업을 찾을 수 없습니다.` |
| `doc_no` 없음 | `작업지시서를 생성한 뒤에 검수할 수 있습니다.` |
| 작업전: 사진 줄 집합 ≠ 구성품 줄 집합 | `구성품 N줄 중 M줄의 사진이 없습니다.` / `구성품에 없는 줄의 사진입니다.` |
| 작업전: 이미 `pre_check_at` 인데 또 촬영 | `작업전 검수를 취소한 뒤에 다시 촬영할 수 있습니다.` |
| 작업전: 구성품이 **0줄** | `구성품이 없어 검수할 수 없습니다.` |
| 완료: 장수 ≠ `PROCESS_DONE_PHOTOS` | `완료 사진 3장을 모두 촬영해 주세요.` |
| 완료: `pre_check_at` 없음 | `작업전 검수를 먼저 마쳐야 합니다.` |
| 이미 `done_at` | `이미 완료된 작업입니다.` |
| 작업전검수 취소인데 `done_at` 있음 | `완료를 먼저 취소해야 합니다.` |
| blob 이 이미지가 아님·크기 0·1MB 초과 | `사진을 읽지 못했습니다. 다시 촬영해 주세요.` |

### 순수 함수 (`assets/js/processing-calc.js`)

| 함수 | 설명 |
|---|---|
| `needQty(qtyPer, jobQty)` | 필요수량 = `qtyPer × jobQty` |
| `expandMasterItems(items, jobQty)` | 마스터 구성품 → `[{line_no, kind, code, name, qty_per, need_qty}]`. `line_no` 는 1부터 |
| `normalizeLots(rows, needQty)` | LOT 행의 **마지막 행에 잔량을 채운다.** 잔량이 0 이하면 그대로 두고 오류는 검증이 낸다. 마지막 행에 `touched` 가 있으면 건드리지 않는다 |
| `validateLots(rows, needQty)` | `{ ok, total, diff, sumMsg, errors: [{ index, field, msg }] }` — 행별·합계 오류 |
| `formatDocNo(date, seq)` | `20260919-01`. `seq ≥ 100` 이면 자릿수를 늘린다(`-100`) |
| `parseDocNo(no)` | `{ date, seq }` 또는 `null` — 순번 비교는 **숫자로** 한다(문자열 비교는 자릿수가 다르면 틀린다) |
| `nextDocSeq(docNos, date)` | 그 날짜의 다음 순번 |
| `calendarGrid(month)` | `'YYYY-MM'` → 일~토 6주(42칸) 날짜 배열 |
| `calendarLanes(jobs, month, opt)` | 레인 배치 (§12) |
| `photoLines(items)` | 작업전 사진 슬롯 = 구성품 줄 번호 집합 (LOT 행을 나눠도 1장) |
| `missingSlots(expected, have)` | 아직 없는 슬롯 — 「검수완료」 허용 조건의 근거 (불변식 P1~P3) |

---

## 7. 권한

`config.js` 의 `PERMISSION` 에 **`manageProcessing`** 을 추가한다.

| 권한 | 관리자 | 용마담당자 | 화주관리자 | 화주영업팀 | 현장작업자 |
|---|:---:|:---:|:---:|:---:|:---:|
| `manageProcessing` 작업·마스터 등록/수정/삭제·문서생성 | ✅ | ✅ | ✅ | ❌ | ❌ |
| `updateStatus` **작업전 검수 · 완료 검수 · 그 취소** (§17) | ✅ | ✅ | ❌ | ❌ | ✅ |

🔑 **검수는 `manageProcessing` 이 아니라 `updateStatus` 다** (A14). 현장작업자는
`manageProcessing` 이 없지만 실제 사진을 찍는 사람이고, 화주관리자는 `manageProcessing` 은
있지만 창고에 없다. **등록 권한과 현장 처리 권한은 원래 다른 축**이고(출고·검수·적치·상차가
전부 `updateStatus` 다) 여기에 새 권한 키를 만들지 않는다 — 매트릭스에 열을 늘리면
"누가 뭘 하는가" 를 볼 곳이 둘이 된다. 판정은 `db.canCheckProcessing(user)` 한 곳,
서버는 이미 있는 `public.can_update_status()` 를 그대로 쓴다.

- **조회는 로그인 사용자 모두**다. `viewAll` 을 보지 않는다(공지사항과 같은 방식) —
  유통가공은 창고 내부 업무라 등록자별로 가릴 이유가 없다
- 화면은 `can(user, 'manageProcessing')` 로만 판정하고 역할명을 직접 비교하지 않는다
- 권한이 없으면 **등록·수정·삭제·문서생성 버튼이 아예 렌더되지 않고**,
  `db.js` 의 쓰기 함수도 같은 조건으로 거부한다(화면 잠금만 두면 db 를 직접 불러 뚫린다 —
  [AGENT_LEARNING_LOG 2026-09-17](AGENT_LEARNING_LOG.md))
- 서버 RLS 는 `can_manage_processing()` 이 같은 기준으로 막는다.
  🔑 **단 `process_jobs` 의 update 정책만 `can_update_status()` 까지 열려 있다** —
  현장작업자가 검수 시각을 찍어야 하기 때문이다. 넓어진 만큼
  **`trg_enforce_process_check_cols` 트리거가 「검수 6컬럼 + `updated_at` 만」 으로 좁힌다**
  (§5-1 🔴). 검수 권한만으로 작업수량·일정·문서번호를 고치면 예외로 막힌다
- 🔑 **사진은 「활성 로그인 사용자」만 본다.** `process_photos` 와 Storage 의 select 정책이
  `public.my_role() is not null` 이라 **중지된 계정(`active = false`)은 토큰이 남아 있어도
  읽지 못한다.** 다른 테이블의 `using (true)` 와 다른데, 사진에는 현장 사람·제품이 찍혀
  개인정보에 가깝기 때문이다. 이 조건은 **사진 두 곳에만** 걸고 기존 테이블은 건드리지 않았다
  (다른 테이블까지 한 번에 좁히면 영향 범위가 이 작업을 넘어선다)
- 🔑 **Storage 쓰기는 권한뿐 아니라 경로도 본다** (`jobs/{살아 있는 작업 id}/…`). 권한만 보면
  버킷이 개인 저장소가 된다 (§5-1)
- 🔑 **하드 삭제(`delete`)는 관리자만**(정책상). 앱은 `deleted_at` 만 찍는 soft delete 라
  일반 경로에서는 쓰지 않는다 — `process_masters` · `process_jobs` 의 delete 정책은
  `my_role() = 'admin'` 이다. 자식 테이블(`process_master_items` · `process_job_items`)은
  구성품을 통째로 교체할 때 DELETE 를 타므로 `can_manage_processing()` 그대로 둔다
- 소속(company)은 보지 않는다. 주문정보등록처럼 `ORDER_POLICY` 를 따로 두지 않는다

---

## 8. 진행상태 전이 🔑 (2026-09-19 개정)

**상태는 사진 증빙이 있는 앱 검수로만 움직인다.** 문서생성은 더 이상 상태를 바꾸지 않는다.

```
작업대기 ──(앱 작업전검수: 구성품별 사진 저장 → 검수완료)──▶ 작업중
   ▲                                                          │
   │                                                          │(앱 완료검수: 사진 3장 저장 → 완료처리)
   └────────(작업전검수 취소 · `···` 메뉴)──────────┐          ▼
                                                   └── 작업완료
                                                        │
                                          (완료검수 취소)─┘
```

| 전이 | 계기 | 저장 | 누가 |
|---|---|---|---|
| 작업대기 → 작업중 | 앱 **작업전 검수** 의 `검수완료` | `pre_check_at` `pre_check_by(_name)` | `updateStatus` |
| 작업중 → 작업완료 | 앱 **완료 검수** 의 `완료처리` | `done_at` `done_by(_name)` | `updateStatus` |
| 작업완료 → 작업중 | 앱 상세 `···` 의 **완료 취소** | `done_at = null` | `updateStatus` |
| 작업중 → 작업대기 | 앱 상세 `···` 의 **작업전검수 취소** | `pre_check_at = null` | `updateStatus` |

```js
/** 진행상태 판정 - 유일한 출처 */
export function processStatus(job) {
    if (job?.done_at) return PROCESS_STATUS.DONE;        // 작업완료
    if (job?.pre_check_at) return PROCESS_STATUS.DOING;  // 작업중
    return PROCESS_STATUS.WAIT;                          // 작업대기
}
```

### 바뀐 것과 근거

| 전 | 후 | 근거 |
|---|---|---|
| `doc_created_at` → `진행` | 상태에서 **뺀다** | 문서를 뽑은 것과 현장이 작업을 시작한 것은 다르다. 전날 미리 뽑아 두면 착수 전인데 `진행` 으로 보였다 |
| 웹 목록·상세의 `작업완료` 버튼 | **제거** (A16) | 완료는 **사진 3장이 있어야** 성립한다. 버튼을 남기면 증빙 없는 완료가 생기고, 그 건은 앱에서 취소하기 전까지 사진을 붙일 수 없다 |
| `setProcessDone(id, user)` | **삭제** | 대체는 `saveDoneCheck`. 남겨 두면 `manageProcessing` 만 가진 역할이 우회 경로로 쓴다 |
| `revokeProcessDone` 권한 `manageProcessing` | `updateStatus` | 켜는 쪽과 끄는 쪽의 권한이 다르면 현장이 자기가 찍은 완료를 못 되돌린다 |

- ⚠️ **웹 상세 팝업에는 `완료취소` 도 두지 않는다.** 되돌리기는 사진을 보며 판단해야 하므로
  앱 상세의 `···` 메뉴 한 곳으로 모은다. 웹은 사진 **썸네일과 상태만** 보여 준다(§17-7)
- **작업대기 → 작업완료 건너뛰기는 그대로 막는다.** `saveDoneCheck` 가 `pre_check_at` 없는
  작업을 거부한다 (작업전 사진이 없으면 「바뀌기 전」 이 기록되지 않는다)
- 🔑 **문서번호(`doc_no`)가 없는 작업은 검수에 뜨지 않는다** (A17). 아래 §17 진입 규칙 참고

---

## 9. 작업현황 탭

### 목록 표

| 컬럼 | 폭 | 비고 |
|---|---|---|
| ☐ | 40px | 다중 선택. 헤더에 전체선택 |
| 연번 | 56px | 표시 순서 |
| 문서번호 | 130px | 없으면 `-` |
| 제품코드 | 140px | |
| 제품명 | 남는 폭 | 클릭 시 상세 팝업 |
| 작업수량 | 90px | `.num` |
| 시작예정일 | 110px | |
| 완료요청일 | 110px | 오늘 지났는데 미완료면 빨강 |
| 진행상태 | 90px | `.tag` — 작업대기 `gray` · 작업중 `blue` · 작업완료 `green` (`PROCESS_STATUS_TONE`) |
| 문서생성 | 110px | 문서 없음 → `생성` 버튼 / 있음 → `보기` 버튼 |

상단 툴바: 시작예정일 범위(`from`~`to`) · 진행상태 · 검색어 · **작업등록** 버튼 ·
선택 건에 대한 **수정**(1건일 때만) · **삭제** · CSV 다운로드(`can(user,'download')`).

### 등록·수정 팝업 (`openModal`, `wide`)

**상단 — 기본정보**

| 항목 | 입력 | 검증 |
|---|---|---|
| 제품코드 | 텍스트 + `datalist`(마스터 목록) | 필수. 마스터에 있어야 한다(§13) |
| 제품명 | **읽기 전용** — 마스터에서 자동 채움 | |
| 작업구분 | **읽기 전용** — 마스터에서 자동 채움 | |
| 작업수량 | 숫자 | 1 이상 정수 |
| 시작예정일 | date | 필수 |
| 완료요청일 | date | 필수. **시작예정일 이상** |

제품코드가 확정되거나 작업수량이 바뀌면 **구성품 표를 다시 그린다.**
이미 입력한 LOT 이 있으면 `confirmDialog('입력한 LOT 이 초기화됩니다. 계속할까요?')` 로 확인한다.

**하단 — 구성품 표** (`db.findProcessMasterByCode` → `expandMasterItems`)

| 구분 | 제품코드 | 품명 | 필요수량 | LOT | 수량 | |
|---|---|---|---|---|---|---|
| 제품 | `P-100` | 000크림 50ml | 100 | `[입력]` | `[30]` | `+LOT` `삭제` |
| 제품 | | | | `[입력]` | `[70]` | |
| 부자재 | | 라벨(수출용) | 100 | — | 100 | |

- `필요수량` = 마스터 `qty_per` × 작업수량 (예: 2 × 50 = 100). **읽기 전용**
- 구성품 한 줄(`line_no`)의 첫 행에만 구분·코드·품명·필요수량을 표시하고
  추가된 LOT 행은 그 칸을 비운다(`rowspan` 대신 빈 칸 — 행 추가·삭제가 잦아 단순하게 간다)

---

## 10. LOT 분할 규칙 🔑

| 규칙 | 내용 |
|---|---|
| 대상 | **`kind === 제품` 행만.** 부자재는 LOT 칸이 `—` 이고 수량이 필요수량으로 고정, 행 추가 불가 |
| 행 추가 | 제품 줄의 `+LOT` 버튼 → 같은 `line_no` 에 행 추가 (`sort_order` +1) |
| 행 삭제 | 2행 이상일 때만 노출. 삭제 후 잔량을 다시 채운다 |
| 잔량 자동 | **마지막 행 수량 = 필요수량 − 앞 행 합.** 사용자가 마지막 행을 직접 고치면 그 값을 쓰고, 그때부터는 자동으로 덮어쓰지 않는다(`data-touched`) |
| 수량 검증 | 1 이상 **정수**. `0` · 음수 · 소수 · 숫자 아님 → 그 행에 오류 표시 |
| 합계 검증 | `합계 === 필요수량`. 초과면 `N 초과`, 부족이면 `N 부족` 을 줄 끝에 빨강으로 |
| LOT 검증 | 한 줄에 2행 이상이면 **LOT 필수**. 1행이면 선택. 같은 줄 안에서 **LOT 중복 금지** |
| 저장 | 오류가 하나라도 있으면 저장 버튼이 막히고 `toast(...,'error')`. **`db.createProcessJob` 도 `validateLots` 로 다시 검증한다** |
| 제품 줄 필수 🔑 | 요청에 **제품 줄의 LOT 행이 하나도 없으면 거부**한다(`제품 구성품 줄이 빠졌습니다`). 예전에는 필요수량 한 행으로 조용히 채웠는데, 그러면 LOT 이 빈 작업지시서가 사용자도 모르게 나간다. 부자재는 지금도 필요수량 한 행으로 채운다 |

```
필요수량 100
  1행  LOT A  30
  2행  LOT B  20
  3행  LOT C  50   ← +LOT 를 누르는 순간 잔량 50 이 자동으로 들어간다
                     합계 100 → 통과
```

오류 표시는 행의 수량 입력칸에 `.is-error` 클래스 + 줄 끝 메시지. 실시간(`input` 이벤트)으로 갱신한다.

---

## 11. 수정·삭제 규칙

| 상태 | 제품코드·작업수량·구성품·LOT | 시작예정일·완료요청일 | 삭제 |
|---|:---:|:---:|:---:|
| 작업대기 · 문서 없음 | ✅ | ✅ | ✅ |
| 작업대기 · 문서 있음 | ❌ | ✅ | ✅ (확인 문구에 문서번호를 적는다) |
| **작업중** (`pre_check_at`) | ❌ | ✅ | ❌ (작업전검수 취소 후 삭제 — A18) |
| 작업완료 | ❌ | ❌ | ❌ (완료취소 → 검수취소 후 삭제) |

- 🔑 **문서번호가 나간 뒤에는 수량·구성품을 고칠 수 없다.** 이미 인쇄된 작업지시서와
  화면의 내용이 달라지기 때문이다. 바꿔야 하면 **삭제 후 재등록**(새 문서번호)한다
- 삭제는 `confirmDialog` 로 확인한다. 다중 선택 삭제는 건수와 문서번호를 문구에 적는다
- 삭제는 **soft delete**(`deleted_at`)다. `doc_no` 의 unique 가 살아 있어 **번호가 재사용되지 않는다**
- 이 조건은 화면(버튼 비활성)과 `db.updateProcessJob` / `db.deleteProcessJobs` **양쪽**에 넣는다
- 🔑 **작업수량·제품코드가 바뀌는데 `patch.items` 가 없으면 거부한다**
  (`작업수량이 바뀌면 LOT 을 다시 입력해야 합니다.` / `제품코드가 바뀌면 …`).
  필요수량이 달라지므로 기존 LOT 을 그대로 쓸 수 없고, 한 행으로 조용히 다시 채우면
  사용자가 나눠 둔 LOT 이 소리 없이 사라진다. 수량·제품이 **그대로**면 `items` 없이도
  기존 구성품을 지킨 채 일정만 고칠 수 있다(일정만 수정 경로)

---

## 12. 작업캘린더 탭

월 달력(일~토 × 6주 = 42칸)에 작업을 **시작예정일 ~ 완료요청일** 막대로 그린다.

상단: `◀ 2026-09 ▶` 월 이동 + `오늘` 버튼. 진행상태 필터는 작업현황과 같은 것을 쓴다.

### 배치 알고리즘 (`calendarLanes(jobs, month, { maxLane = 3 })`)

1. **그리드** — 그 달 1일이 속한 주의 **일요일**부터 42칸 고정 (달마다 높이가 변하지 않는다)
2. **대상** — 그리드 기간과 하루라도 겹치는 작업만. 정렬은 `시작일 ↑ → 기간 긴 것 먼저 → id`
3. **주 단위로 자른다** — 작업이 주 경계를 넘으면 주마다 조각(`segment`)을 만든다.
   조각에는 `startsHere` / `endsHere` 를 붙여 막대 끝 모양(둥근 모서리·화살표)을 정한다
4. **greedy 레인 배정** — 각 주에서 조각을 순서대로 보며 **겹치지 않는 가장 작은 lane**에 넣는다.
   레인은 주마다 다시 배정한다(주가 바뀌면 높이가 달라질 수 있지만 훨씬 촘촘하다 — 달력 앱의 통상 방식)
5. **넘침** — `lane >= maxLane` 인 조각은 그리지 않고 그 조각이 덮는 **날짜 칸마다**
   `overflow[dayIndex] += 1`. 칸 아래에 `+N` 을 표시하고 클릭하면 그 날짜의 작업 목록 팝업
6. **클릭** — 막대를 누르면 작업현황의 **상세 팝업을 그대로 연다**(같은 함수를 부른다)

반환 모양:

```js
{
  weeks: [{
    days: ['2026-08-30', ...7개],
    bars: [{ jobId, lane, colStart, colSpan, startsHere, endsHere }],
    hidden: [{ jobId, colStart, colSpan, startsHere, endsHere }],   // 넘쳐서 안 그린 조각
    overflow: [0, 0, 2, 1, 0, 0, 0],      // 날짜칸별 숨긴 개수
  }, ...6개]
}
```

🔑 **`hidden` 은 구현에서 더한 것이다.** `overflow` 만으로는 `+N` 을 눌렀을 때 **무엇이 숨었는지**
알 수 없어 그 날짜의 목록 팝업을 그릴 수 없다. 불변식 C3·C5 도 이 값으로 센다
(총 계수 = 그린 칸 + 숨긴 칸).

### 불변식 (랜덤 검증용 — `tools/processing-check.js`)

| 번호 | 내용 |
|---|---|
| C1 | 같은 주·같은 lane 의 두 막대는 날짜가 겹치지 않는다 |
| C2 | 모든 막대가 `0 ≤ colStart` 이고 `colStart + colSpan ≤ 7` |
| C3 | 작업이 덮는 그리드 내 모든 날짜는 **그려진 막대 또는 overflow 로 정확히 한 번** 계수된다. 날짜칸마다 `overflow[i]` = **그 칸을 덮는 `hidden` 조각 수** — `+N` 버튼의 숫자와 팝업 목록이 같은 값에서 나와야 한다(총합만 맞추면 「+3 인데 목록엔 1건」을 못 잡는다) |
| C4 | `lane < maxLane` — 넘친 것은 `bars` 에 없다 |
| C5 | 같은 작업의 조각을 이으면 원래 기간과 같다(그리드로 잘린 부분 제외) |

**순수 함수로 두는 이유**: 겹침·넘침·주 경계는 손으로 만든 예시로는 조합이 몇 가지 안 나온다.
랜덤 작업 수천 건으로 C1~C5 를 세는 편이 훨씬 빠르게 결함을 잡는다.

---

## 13. 작업마스터 탭

### 목록 표

| 컬럼 | 비고 |
|---|---|
| 연번 · 작업구분 · 제품코드 · 제품명 · 구성품 수 · 등록자 · 등록일 | 행 클릭 시 수정 팝업 |

상단: 검색어 · 작업구분 필터 · **마스터 등록** 버튼.

### 등록·수정 팝업 (`openModal`, `wide`)

**상단** — 작업구분(라벨/해체/세트 라디오 또는 select) · 제품코드 · 제품명
**하단 — 구성품 표**

| 구분 | 코드 | 품목명 | 필요수량 | |
|---|---|---|---|---|
| `제품 ▾` | `P-100` | 000크림 50ml | `2` | `삭제` |
| `부자재 ▾` | (비워둠) | 라벨(수출용) | `2` | `삭제` |

`+ 구성품 추가` 버튼으로 행을 늘린다. 검증:

- 구성품 **1건 이상** 필수, 제품 구분이 **1건 이상** 있어야 한다(작업지시서에 LOT 줄이 필요하다)
- 품목명 필수 · `qty_per` 는 1 이상 정수
- 코드는 부자재만 비울 수 있다. **제품 구분은 코드 필수**
- 제품코드 중복(살아 있는 마스터) 거부 — 서버 unique 와 화면 검증 두 겹

---

## 14. 부자재관리 탭

이번에는 **자리만 만든다.**

```html
<div class="empty">부자재관리 화면은 준비 중입니다.</div>
```

테이블도 만들지 않는다. 재고·입출고 모델이 정해지지 않은 상태에서 스키마를 먼저 만들면
쓰이지 않는 컬럼이 남는다. 요구사항이 확정되면 그때 설계한다.

---

## 15. 작업지시서 (문서생성)

### 문서번호 규칙

| 항목 | 내용 |
|---|---|
| 형식 | `YYYYMMDD-NN` (예 `20260919-01`) |
| 기준일 | **문서를 생성한 날**(작업일이 아니다) |
| 순번 | 그 날짜의 마지막 번호 + 1. 2자리 zero pad, **99 를 넘으면 3자리**(`-100`) |
| 고정 | 한 번 나가면 **바꾸지 않는다.** 재생성 불가 — 버튼이 `생성` → `보기` 로 바뀐다 |
| 재사용 | 작업을 삭제해도 번호는 되돌아오지 않는다(soft delete + unique) |

### 문서 화면

`status.js` 의 상차라벨 인쇄 방식을 **그대로 따른다** (판단: 새 방식을 만들지 않는다).

```js
const win = window.open('', '_blank', 'width=900,height=1100');
win.document.write(docHtml(job, items));   // <body onload="window.print()">
win.document.close();
```

- 인쇄 전용 창이라 앱 CSS 를 쓰지 않는다. `@page { size: A4 portrait; margin: 12mm }`
- **모든 값은 `esc()`** 를 거친다 (제품명·LOT 은 사용자 입력이다)
- 🔑 **문서번호 Code128 바코드를 머리 오른쪽(문서번호 아래)에 넣는다** — 앱의 검수 화면이
  이 종이를 스캔해 작업을 연다(§17). `barcode.js` 의 `code128Svg(job.doc_no)` 를 그대로 쓴다.
  문서번호가 없으면(아직 채번 전) 바코드 자리를 비운다
- 문서번호는 `YYYYMMDD-NN` 이라 **숫자와 `-` 뿐**이고 Code128-B 로 그대로 들어간다.
  주문번호(`a11111`)와 형식이 달라 상차라벨 바코드와 섞이지 않는다
- **테스트 시트(`barcodes.html`)에 「유통가공 문서번호」 절을 더한다.** 실물 지시서를
  뽑지 않고도 스캔을 확인해야 하기 때문이다 (절차는 [testing.md](testing.md))

구성:

```
┌──────────────────────────────────────────────┐
│  유통가공 작업지시서            문서번호 20260919-01 │
│                                    출력일 2026-09-19 │
├──────────────────────────────────────────────┤
│ 작업구분 │ 라벨      │ 제품코드 │ P-100            │
│ 제품명   │ 000크림 50ml         │ 작업수량 │ 50개   │
│ 시작예정일│ 2026-09-20 │ 완료요청일 │ 2026-09-22   │
├──────────────────────────────────────────────┤
│ 구분 │ 코드 │ 품명 │ 필요수량 │ LOT │ 수량          │
│ 제품 │P-100 │000크림│   100   │  A  │  30          │
│ 제품 │      │       │         │  B  │  70          │
│ 부자재│     │라벨   │   100   │  —  │ 100          │
├──────────────────────────────────────────────┤
│ 작업자 서명            확인자 서명                 │
└──────────────────────────────────────────────┘
```

---

## 16. 공통 주의

- **사용자 입력은 모두 `esc()`** 로 이스케이프한다. 제품명·LOT·품목명·문서 인쇄 HTML 전부
- **`render()` 는 정리 함수를 반환한다** — `return db.subscribe(guarded)`
- 🔑 실시간 갱신 가드는 `checklist.js` 의 `guarded()` 를 본뜬다.
  **입력 중이거나 팝업이 열려 있으면 다시 그리지 않는다.**
  LOT 을 여러 줄 입력하는 중에 리렌더가 돌면 입력값이 통째로 날아간다

```js
function guarded() {
    const el = document.activeElement;
    if (el && body.contains(el) && el.matches('input, textarea, select')) return;
    if (document.querySelector('.modal-back')) return;
    reload();
}
```

- 스타일은 기존 클래스(`.card` `.grid` `.tag` `.toolbar` `.field` `.table-wrap`)를 재사용한다.
  캘린더만 새 클래스가 필요하다(`.pc-cal` `.pc-week` `.pc-bar` `.pc-more` — `pc-` 접두)
- 색상은 `:root` CSS 변수만 쓴다. 표는 `.table-wrap` 으로 감싸 가로 스크롤시킨다

---

---

## 17. 모바일 검수 (`#/pcheck`) 🔑

현장이 휴대폰으로 **작업 전·후 사진을 남기는** 화면. 화면 배치·조작은
[mobile.md §3-8](mobile.md#3-8-유통가공-pcheck) 에, **업무 규칙은 여기**에 둔다.

```
앱 탭 「가공」  #/pcheck
   세그 [ 작업전 검수 | 완료 검수 | 캘린더 ]
      │
      │ 진입 3가지 : ① 목록 카드 탭  ② 문서번호 직접 입력  ③ 작업지시서 바코드 스캔
      ▼
   #/pcheck/pre/:id     구성품 줄마다 사진 1장 → [저장] → [검수완료]  → pre_check_at
   #/pcheck/done/:id    완료 제품 사진 3장     → [저장] → [완료처리]  → done_at
```

### 17-1. 진입 규칙

| 규칙 | 내용 |
|---|---|
| 대상 | **`doc_no` 가 있는 작업만** (A17). 세 진입 경로가 모두 같은 모집단을 본다 |
| 작업전 검수 목록 | `pre_check_at` 없는 건. 시작예정일 ↑ |
| 완료 검수 목록 | `pre_check_at` 있고 `done_at` 없는 건 |
| 이미 끝난 건 | 목록에는 없지만 **문서번호 입력·스캔으로는 열린다** — 사진을 다시 보고 `···` 로 취소하기 위해서다. 열면 읽기 전용 |
| 단계가 다른 건 | 안내 + 해당 세그로 옮기는 버튼 (`ship.js` `inspect.js` 의 관례와 같다) |

🔑 **문서번호가 없는 작업을 목록에만 넣지 않는다 (판단 근거).** 진입 경로 2개(입력·스캔)가
문서번호 기반이라 목록만 예외를 두면 **같은 작업이 경로에 따라 열리거나 안 열린다.**
게다가 작업전 검수만 허용하면 그 작업은 `작업중` 이 된 뒤 완료 검수에서 막혀
**앱에서 빠져나갈 길이 없다**(문서생성은 웹 권한이다). 막다른 길을 만들지 않는 쪽을 고른다.
→ 대신 웹 작업현황에서 **문서 없는 작업은 `생성` 버튼이 이미 눈에 띄게 있다.**

### 17-2. 사진 규칙

| 단계 | 장수 | 슬롯 키 | Storage 경로 |
|---|---|---|---|
| 작업전 (`pre`) | **구성품 줄 수만큼** (제품·부자재 모든 `line_no` 에 1장) | `line_no` | `jobs/{job_id}/pre/{line_no}.jpg` |
| 완료 (`done`) | **정확히 3장** (`PROCESS_DONE_PHOTOS`) | `seq` 1·2·3 | `jobs/{job_id}/done/{seq}.jpg` |

- 경로가 **결정적**이다 🔑 — 재촬영·재저장이 같은 파일을 덮어쓰므로 Storage 에 고아가 쌓이지
  않는다. 랜덤 파일명을 쓰면 취소·재촬영마다 쓰레기가 남고 지우는 코드가 따로 필요해진다
- 작업전은 **LOT 행이 아니라 구성품 줄(`line_no`)** 기준이다. 한 구성품을 LOT 3개로 나눠도
  실물은 한 품목이라 사진은 1장이다
- 압축은 `assets/js/photo.js` 한 곳에서 한다 (아래)

### 17-3. 사진 압축 (`assets/js/photo.js`)

```js
export const PHOTO = {
    maxEdge: 1280,        // 긴 변
    quality: 0.7,         // JPEG 첫 시도
    targetBytes: 200 * 1024,
    steps: [              // 목표를 못 맞추면 순서대로 낮춘다
        { edge: 1280, q: 0.7 }, { edge: 1280, q: 0.55 },
        { edge: 1024, q: 0.55 }, { edge: 1024, q: 0.45 }, { edge: 800, q: 0.45 },
    ],
};
/** File → 압축 Blob. 순수하게 입력만 보고 돌려준다(저장·업로드하지 않는다) */
export async function compressPhoto(file, opt = {}) // → { blob, width, height, size }
```

- `createImageBitmap(file, { imageOrientation: 'from-image' })` 로 **EXIF 회전을 먼저 편다.**
  안 펴면 세로로 찍은 사진이 웹 상세에서 눕는다
- 마지막 단계에서도 목표를 못 맞추면 **그 결과를 그대로 쓴다.** 거부하지 않는다 —
  같은 자리를 다시 찍어도 결과가 같아서 현장이 빠져나갈 수 없다. 1MB 초과만 db 가 막는다
- ⚠️ **HEIC 는 브라우저 디코딩에 맡긴다.** `capture="environment"` 로 찍으면 iOS 도 JPEG 를
  주지만, 앨범에서 HEIC 를 고르면 기기에 따라 디코딩이 실패한다. 그때는
  `사진을 읽지 못했습니다. 다시 촬영해 주세요.` 로 안내하고 **디코더 라이브러리를 넣지 않는다**
  (첫 로드 gzip 65KB 전제를 깬다 — [CLAUDE.md](../CLAUDE.md) 기술 구성)
- 압축은 **업로드 직전이 아니라 촬영 직후**에 한다. 원본(3~8MB)을 메모리에 들고 있으면
  구성품 10줄짜리 작업에서 폰이 죽는다

### 17-4. 촬영 → 저장 → 검수완료 (커밋 지점) 🔑

```
[촬영]  <input type="file" accept="image/*" capture="environment">
          → compressPhoto()  → 화면 메모리(Blob) + IndexedDB 초안
[저장]  → putFile() 업로드 → process_photos upsert            ← 서버에 남는 첫 시점
[검수완료] → pre_check_at (또는 done_at) 기록 → 상태가 바뀐다
```

| 안 | 장점 | 단점 | 판정 |
|---|---|---|---|
| 촬영 즉시 업로드 | 앱이 죽어도 사진이 남는다 | 검수를 끝내지 않은 작업의 파일이 서버에 남는다. 재촬영마다 왕복 | — |
| 저장 시 일괄 업로드 (**추천**) | 사용자가 「저장」을 커밋으로 인지한다. 재촬영이 공짜 | 저장 전에 앱이 죽으면 사진이 날아간다 | ✅ |

**추천안 + 초안 보관으로 단점을 없앤다.** 촬영분을 `assets/js/idb.js` 의 초안 스토어
(`tpl_files/drafts`, 키 `${job_id}:${phase}:${slot}`)에 함께 넣어 두고, 화면에 다시 들어오면
복구한다. 저장이 성공하면 초안을 지운다. **mock 모드의 파일 저장소와 같은 IndexedDB 모듈을
재사용**하므로 새로 만드는 코드가 한 겹뿐이다.

- 「저장」 이 끝나야 「검수완료」 버튼이 열린다. 판정은 **화면 상태가 아니라
  `db.listProcessPhotos()` 가 돌려준 메타 행 수**로 한다 — 저장 실패를 화면 플래그로만
  가리면 «저장한 줄 알았는데 안 된» 상태로 완료가 눌린다
- 업로드가 여러 장 중 일부만 성공하면 **`pre_check_at` 을 찍지 않고** 성공한 것만 메타에
  남긴다. 다시 「저장」을 누르면 남은 것만 올라간다(경로가 결정적이라 중복이 없다)
- 업로드 성공 · 메타 저장 실패면 `invalidate()` 후 오류를 던진다
  ([학습로그 2026-09-19](AGENT_LEARNING_LOG.md) — 되돌릴 수 없는 값의 실패 경로)

### 17-5. 캘린더 세그

- 웹과 **같은 순수 함수** `processing-calc.js` 의 `calendarLanes()` `calendarGrid()` 를 쓴다.
  앱 화면이 `pages/**` 를 import 하지 않는다는 규칙은 지켜진다 — 계산 모듈은 공용이다
  (`checkflow.js` 선례, [mobile.md §3-7](mobile.md))
- 앱은 폭이 좁아 `maxLane = 2` 로 부른다. 넘친 것은 웹과 같이 `+N`
- 막대 색 = `PROCESS_STATUS_TONE[job.status]` — **웹 `.pc-bar--*` 와 같은 토큰**,
  클래스 이름만 `m-cal-bar--*` 다 (앱 CSS 는 `m-` 접두, 웹 클래스를 재사용하지 않는다)
- 막대를 누르면 그 작업의 상세 시트가 뜬다. 현재 세그와 단계가 맞으면 검수 화면으로 가는
  버튼이 함께 나온다

### 17-6. 파일 구성

| 파일 | 책임 |
|---|---|
| `assets/js/mobile/screens/pcheck.js` | 앱 화면 1개 — 세그 3개 · 목록 · 스캔 · 상세(작업전/완료) |
| `assets/js/mobile/ui.js` (추가) | `photoSlot()` / `bindPhotoSlots()` — 촬영 칸·썸네일·재촬영. **작업전과 완료가 같은 조각을 쓴다**(2회 반복 = 공통화 기준) |
| `assets/js/photo.js` (신규) | 압축 (순수 계산 + canvas) |
| `assets/js/idb.js` (신규) | IndexedDB 래퍼 — mock 파일 저장소(`files`) + 초안 보관(`drafts`) |
| `assets/js/store.js` (추가) | `putFile` `fileUrls` · `processPhotos` 테이블 · `pushChanges` 0행 감지 |
| `assets/js/auth.js` (추가) | `signOut()` 이 IndexedDB 초안(과 mock 사진)을 함께 지운다 |
| `assets/js/db.js` (추가) | §6 「모바일 검수」 함수들 |

**화면을 한 파일로 두는 이유**: 세 세그가 같은 목록·스캔 바·상세 시트를 공유한다.
나누면 그 공유 조각을 또 다른 파일로 빼야 해서 파일이 5개가 된다. 앱 화면 층의 관례도
`화면 = 파일 1개`(`stow.js` 810줄 · `load.js` 477줄)다. **700줄을 넘으면** 웹
`pages/checklist/*` 처럼 `screens/pcheck/` 로 나눈다.

### 17-7. 웹 변경점 (같은 상태를 같은 색으로)

| 파일 | 바꿀 것 |
|---|---|
| `config.js` | `PROCESS_STATUS` 값 3개(`작업대기`/`작업중`/`작업완료`) · `PROCESS_PHASE` · `PROCESS_DONE_PHOTOS` 추가 |
| `db.js` | `processStatus` 판정 교체 · `setProcessDone` 삭제 · `revokeProcessDone` 권한 교체 · §6 신규 함수 |
| `pages/processing/jobs.js` | 목록 **`작업완료` 버튼 제거**(툴바·상세 팝업 둘 다) · 상세 팝업에 **사진 썸네일 줄**(작업전 N장 · 완료 3장, 누르면 원본 크기 팝업) · 검수자·검수시각 행 · CSV 헤더의 상태값 |
| `pages/processing/calendar.js` | 손댈 곳 없다 — `statusTone()` 을 이미 쓰고 있어 색이 자동으로 따라온다 |
| `pages/processing/common.js` | 손댈 곳 없다 (`PROCESS_STATUS_TONE` 을 그대로 읽는다) |
| `pages/processing/doc.js` | 문서번호 **Code128 바코드** 추가 (§15) |
| `barcodes.html` | 「유통가공 문서번호」 절 추가 |
| `assets/css/app.css` | 사진 썸네일 줄 클래스(`.pc-thumbs`) |

⚠️ **상태 문자열이 바뀌므로 저장된 필터 값·CSV 는 옛 값(`대기`)을 못 맞춘다.**
상태는 저장하지 않는 계산값이라 DB 마이그레이션은 필요 없지만, `f.status` 를 URL·화면
상태로 들고 다니는 곳이 있으면 한 번 비워야 한다 (지금은 메모리 상태뿐이라 영향 없음).

---

## 구현 시 바꾼 것 (설계안 대비)

설계서대로 구현했고, 아래 것들만 근거를 두고 바꿨다.
(⑦ 은 코드리뷰팀이, ⑧~⑪ 은 코드리뷰·DB 감사, ㉑~㉖ 은 DB·보안·코드리뷰 2차 감사 지적이다)

| # | 바꾼 것 | 근거 |
|---|---|---|
| ① | **`createProcessJob` · `updateProcessJob` 이 구성품 스냅샷을 마스터에서 다시 읽는다.** 화면이 보내는 `items` 는 `{line_no, lot, qty}` 뿐이고 `kind` `code` `name` `qty_per` 은 받지 않는다 (`db.js` 의 `buildJobItems`) | 화면이 보낸 값을 그대로 저장하면 조작된 요청으로 **마스터와 다른 작업지시서**를 만들 수 있다. 화면 잠금만 두면 db 를 직접 불러 뚫린다는 저장소 교훈과 같은 자리다. 마스터에 없는 `line_no` 가 섞이면 거부한다 |
| ② | `validateLots` 반환에 **`field`(`'qty'`/`'lot'`) · `diff` · `sumMsg`** 를 더했다 | `errors` 에 행 번호만 있으면 LOT 오류인데 수량칸에 빨간 테두리가 붙는다. 합계 오류(`N 초과`/`N 부족`)는 행 오류가 아니라 줄 끝에 따로 붙어야 한다 |
| ③ | `calendarLanes` 반환의 주마다 **`hidden`**(넘쳐서 안 그린 조각)을 더했다 | `+N` 클릭 팝업을 그릴 수 없고, 불변식 C3·C5 를 셀 수 없다 (§12 참고) |
| ④ | `normalizeLots` 가 마지막 행의 **`touched`** 를 본다 | 「마지막 행을 직접 고치면 덮어쓰지 않는다」(§10)는 규칙을 화면이 아니라 **순수 함수 한 곳**에 두어 랜덤 검사(L1·L2)로 지킬 수 있게 했다 |
| ⑤ | `schema.sql` 에 **`trg_enforce_process_doc_no`** 트리거를 더했다 (`doc_no` 가 한 번 정해지면 변경 불가) | 「한 번 나가면 바꾸지 않는다」는 §15 의 핵심 규칙인데 `unique` 는 **중복만** 막고 갈아끼우기는 막지 못한다. 업무 규칙이 아니라 **불변 보장**이라 서버에 두는 것이 맞다 (`updated_at` 트리거를 두지 않는 방침과 충돌하지 않는다) |
| ⑥ | 권한이 없는 사용자도 마스터 팝업을 **읽기 전용**으로 열 수 있다 (입력칸 잠금 · 저장·삭제 버튼 없음) | §7 은 「등록·수정·삭제 버튼이 렌더되지 않는다」이지 조회 금지가 아니다. 조회는 로그인 사용자 모두이므로(A2) 구성품을 볼 길을 막지 않는다 |
| ⑦ | **작업 수정 팝업의 구성품 줄은 스냅샷이 아니라 «현재 마스터»로 펼친다** (LOT 행만 저장값에서 가져오고, 그 자리의 품목이 바뀌었으면 옛 LOT 을 붙이지 않는다). 마스터가 지워졌을 때만 스냅샷으로 펼친다 | 저장할 때 `db.updateProcessJob` 이 마스터를 다시 읽어 검증하므로(구현 ①), 화면만 스냅샷을 보여주면 마스터가 바뀐 뒤 **화면은 통과인데 저장이 거부되는** 상태가 된다. 인쇄된 작업지시서를 지키는 것은 `doc_no` 잠금(§11)이지 수정 폼의 스냅샷이 아니다 |
| ⑧ | **`buildJobItems` 가 제품 줄의 LOT 행이 없으면 거부한다** (`제품 구성품 줄이 빠졌습니다`). 전에는 `[{lot:'', qty: 필요수량}]` 으로 조용히 채웠다 (§10) | 조용한 채움은 **LOT 이 빈 작업지시서**를 사용자도 모르게 현장에 내보낸다. 화면(`jobform.js`)은 언제나 제품 줄을 함께 보내므로 화면에서 막히는 경로가 없고, 막는 쪽이 손해가 없다 |
| ⑨ | **`updateProcessJob` 은 작업수량·제품코드가 바뀌는데 `items` 가 없으면 거부한다** (§11). 둘 다 그대로면 `items` 없이 일정만 고칠 수 있다 | 수량이 바뀌면 필요수량이 달라져 기존 LOT 을 그대로 쓸 수 없다. 옛 `keep = []` 경로는 ⑧ 의 조용한 채움에 기대어 **사용자가 나눠 둔 LOT 을 소리 없이 한 행으로 뭉갰다.** 그 경로를 없애고 「기존 구성품 유지」와 「다시 입력」으로 갈랐다 |
| ⑩ | **`await` 없이 부르는 비동기 팝업을 `openSafe()` 로 감쌌다** (`common.js`. `jobs.js` · `calendar.js` · `master.js` 의 클릭 핸들러) | 목록·캘린더의 클릭 핸들러는 팝업을 열어 두고 끝난다. 팝업 안 조회가 실패하면 **아무 반응 없이** 처리되지 않은 rejection 만 남아 사용자는 이유를 알 수 없었다 |
| ⑪ | **`process_masters` · `process_jobs` 의 delete 정책을 `my_role() = 'admin'` 으로 좁히고** (§7), `can_manage_processing()` · `enforce_process_doc_no()` 에 `set search_path = public` 을 더했다. `process_jobs.master_id` FK 는 `on delete set null`, realtime publication 은 멱등 `do $$` 가드로 바꿨다 | DB 감사 지적. 앱은 soft delete 만 쓰므로 하드 삭제 경로를 열어 둘 이유가 없다(자식 구성품 테이블은 통째 교체가 DELETE 를 타므로 그대로 둔다). 마스터를 하드 삭제해도 작업과 지시서가 살아야 하고(스냅샷), `alter publication ... add table` 은 재실행 시 42710 으로 죽는다 |

#### 모바일 검수(§17)에서 바꾼 것

| # | 바꾼 것 | 근거 |
|---|---|---|
| ⑫ | **`savePreCheck` 를 `save*` + `complete*` 두 함수로 갈랐다** (§6) | 커밋 지점이 둘(저장 / 검수완료)인데 함수가 하나면 「저장」만 눌러도 상태가 바뀐다. 설계서의 §6 표와 §17-4 그림이 어긋나 있던 자리다 |
| ⑬ | 사진 슬롯 계산을 **순수 함수 2개**(`photoLines` · `missingSlots`)로 빼고 `tools/processing-check.js` 에 불변식 P1~P3 를 더했다 | 「사진이 다 찼는가」 는 상태를 바꾸는 허용 조건이라 랜덤 검사로 지킬 값이다. db.js 안에 인라인으로 두면 브라우저 없이 셀 수 없다 |
| ⑭ | **앱 상세는 실시간 구독을 걸지 않는다** (저장·완료·취소 뒤 직접 다시 읽는다) | 촬영 도중 폴링 재렌더가 돌면 초안 썸네일과 파일 선택이 끊긴다. 목록·캘린더는 종전대로 구독한다 |
| ⑮ | 상수 이름은 **`PROCESS_PHASE`**(설계서 값) 하나이고, 표시 문구 `PROCESS_PHASE_LABEL` 을 함께 두었다 | 「작업전 검수」·「완료 검수」 를 세그·안내·목록 제목이 같은 말로 쓰게 한다 (화면에 문자열을 직접 쓰지 않는 규칙) |
| ⑯ | 저장 실패 시 **초안(IndexedDB)을 지우지 않는다** | 경로가 결정적이라 다시 저장해도 중복이 없다. 실패했는데 초안을 지우면 현장이 다시 찍어야 한다 |
| ⑰ | `photo.js` 는 단계마다의 결과 중 **가장 작은 것**을 쓴다 (마지막 결과가 아니라) | 드문 입력에서 품질을 낮췄는데 오히려 커지는 경우가 있다. 어차피 목표를 맞추면 그 자리에서 멈춘다 |
| ⑱ | **`savePreCheck` 가 이미 `pre_check_at` 인 건을 거부하고, `completePreCheck` 가 구성품 0줄을 거부한다** (코드리뷰팀) | 앞은 화면만 읽기 전용이라 db 를 직접 부르면 **증빙 사진을 소리 없이 갈아끼울** 수 있었다. 뒤는 `missingSlots([], []) === []` 이라 사진 0장으로 작업중이 된다(학습로그 2026-09-16 「`b === 0` 이면 늘 통과」) |
| ⑲ | **웹 상세 팝업이 만료된 썸네일을 그 자리에서 다시 발급받는다** (`bindPhotoRetry` · 코드리뷰팀) | 서명 URL 은 600초다. 팝업을 열 때마다 새로 발급하지만 **오래 열어 두면** 그림이 깨진 채로 남았고 다시 열기 전에는 방법이 없었다. 깨진 그림만 1회 재발급한다 |
| ⑳ | **초안(IndexedDB)을 못 써도 촬영·저장은 된다** (코드리뷰팀) | 사파리 프라이빗 모드 등에서 저장소 열기가 실패하면 상세 화면이 통째로 뜨지 않았다. 초안은 보조 장치라 실패를 안내만 하고 진행한다. 이 단계에 없는 칸의 옛 초안도 버린다(보이지 않으면서 저장만 막았다) |

#### 2차 감사(DB·보안·코드리뷰)에서 고친 것

| # | 바꾼 것 | 근거 |
|---|---|---|
| ㉑ | 🔴 **`process_jobs_update` 정책을 `can_update_status()` 까지 열고 `trg_enforce_process_check_cols` 트리거로 컬럼을 좁혔다** (§5-1) | 정책이 `can_manage_processing()` 뿐이라 **현장작업자의 검수가 서버에서 0행으로 조용히 실패**했다. mock 모드로만 확인해 발견이 늦었다 — 실서버였다면 검수 기능 전체가 동작하지 않았다 |
| ㉒ | 🔴 **`store.js` 의 `pushChanges` 가 수정·삭제 결과를 `.select('id')` 로 되읽어 0행이면 오류를 던진다** (§4) | ㉑ 이 「조용히」 실패한 이유가 이것이다. PostgREST 는 RLS 가 거른 0행을 성공으로 준다. 서버가 막은 것을 화면이 모르면 사용자는 「저장됐습니다」 를 믿는다. select 정책이 좁은 6테이블(`scopedSelect`)은 쓰기 성공에도 되읽기가 0행일 수 있어 뺐다 |
| ㉓ | **`process_photos` 에 슬롯 CHECK 를 더하고, `photoLines()` 도 `line_no > 0` 만 슬롯으로 본다** (§5-1) | `unique` 는 중복만 막고 `phase` 와 슬롯 키가 어긋난 행은 받는다. 그러면 `coalesce(line_no, -1)` 이 헛돌아 같은 자리에 행이 둘 생긴다. 클라이언트도 같은 조건으로 좁혀 「저장은 되는데 서버가 거부」 하는 경로를 없앴다 |
| ㉔ | **Storage insert·update 정책에 경로 조건**(`jobs/{살아 있는 작업 id}/…`)**을 더하고, `process_photos_update` 의 `with check` 에 `taken_by = auth.uid()` 를 더했다** | 권한만 보면 검수 권한자가 버킷을 개인 저장소로 쓸 수 있고, 재촬영으로 증빙의 **명의를 바꿔치기** 할 수 있었다. 경로를 만드는 곳이 `photoPath` 하나라 정상 경로는 막히지 않는다 |
| ㉕ | **사진 조회를 「활성 로그인 사용자」로 좁혔다** (`my_role() is not null` · 메타와 Storage 둘 다) | 사진에는 현장 사람·제품이 찍혀 다른 표 데이터보다 민감하다. 중지된 계정의 토큰이 남아 있어도 사진은 보이지 않게 한다. **사진 두 곳에만** 걸고 기존 테이블은 건드리지 않았다 |
| ㉖ | **`signOut()` 이 IndexedDB 초안(mock 이면 사진 파일도)을 지운다. `store.js` 의 `removeFile` 과 `listProcessJobsForCheck` 의 `f.date` 는 호출자가 없어 제거했다** | 초안·사진은 세션 저장소가 아니라 IndexedDB 라 로그아웃해도 남아 **공용 단말에서 다음 사용자가 앞사람의 현장 사진을 본다.** 저장소를 못 열어도 로그아웃은 진행한다. 쓰는 곳 없는 삭제 API 는 나중에 권한 검사 없이 불리는 자리가 된다 |
| ㉗ | `process_photos_job_idx`(job_id, phase) 를 **만들지 않는다** (`drop index if exists`) | 슬롯 unique 의 선두 두 컬럼과 겹쳐 읽기에 보탬이 없고 쓰기만 느려진다 |

### 열린 이슈 (사진)

확인을 받아야 하거나 이번 범위 밖이라 **문서에만 적어 둔** 것이다.

| # | 내용 | 지금 상태 |
|---|---|---|
| S1 | **고아 사진 파일 정리 경로가 없다.** 작업을 취소·삭제(soft delete)해도 `process_photos` 행과 Storage 파일은 남는다. `process_jobs` 를 **하드 삭제**하면 메타는 `on delete cascade` 로 지워지지만 **파일은 버킷에 남는다** | 파일 삭제 API 를 두지 않았다(㉖). 정리가 필요해지면 서버 쪽 일괄 작업(Edge Function · cron)으로 만든다 — 클라이언트에 지우는 길을 열면 권한 검사 없이 불리는 자리가 생긴다 |
| S2 | **부분 업로드의 계약이 「서버 우선」이다.** 여러 장 중 일부만 올라가면 성공한 것만 메타에 남고 `pre_check_at` 은 찍히지 않는다. 다시 「저장」을 누르면 남은 것만 올라간다(경로가 결정적). 다만 **업로드는 됐는데 메타 저장이 실패**하면 Storage 에 파일만 남는다 | `invalidate()` 후 오류를 던져 화면이 다시 읽게 한다. 남은 파일은 같은 경로라 다음 저장이 덮어쓴다 — 고아가 되지는 않지만 검수를 끝내 포기하면 S1 로 넘어간다 |
| S3 | 서명 URL 600초 · 깨진 그림만 1회 재발급(⑲). **아주 오래 열어 두면 두 번째 만료는 잡지 못한다** | 실사용에서 팝업을 10분 넘게 열어 두는 경우가 확인되면 주기 갱신으로 바꾼다 |

필요수량 계산은 **화면도 `processing-calc.js` 의 `needQty()` 를 직접 부른다**
(`steps.js` · `checkflow.js` 와 같은 자리다 — 순수 계산 모듈은 화면이 바로 import 한다).
`db.js` 를 거쳐 다시 내보내면 같은 계산에 경로가 둘이 되어, 한쪽만 고치는 순간 값이 갈린다.

### 모바일 검수까지 확인한 것 (mock 모드 브라우저 · 390×844)

웹에서 마스터·작업 등록 → 문서생성(`20260919-01`, **상태는 작업대기 그대로**) →
앱 탭 6개(「가공」) → 작업전 검수(문서번호 검색 → 구성품 2줄 촬영 1.1MB→172KB 압축 → 저장 →
검수완료 → **작업중**) → 완료 검수(3장 → 완료처리 → **작업완료**) → 캘린더 막대·범례 3색 →
웹 목록·상세의 상태 배지·사진 썸네일 5장·검수자/시각까지 확인했다.
막는 것도 함께 확인했다 — 사진 0장이면 독의 「검수완료」가 잠기고 `completePreCheck` 도
`구성품 2줄 중 2줄의 사진이 없습니다.` 로 거부, 문서번호 없는 작업은 목록에서 제외(A17),
저장 전 촬영분이 IndexedDB 초안으로 복구, `···` 작업전검수 취소 → 작업대기,
단계가 다른 건은 안내 + 이동 버튼, 화주영업팀은 촬영 칸·독이 없고 `savePreCheck` 도
`유통가공 검수 권한이 없습니다.` 로 거부.

#### 2차 감사 반영 뒤 다시 확인한 것 (mock · 390×844 · **현장작업자 계정**)

앞의 확인은 관리자 계정이었다. ㉑ 이 「등록 권한이 없는 역할」의 구멍이었으므로
**현장작업자(`worker` · 협력사)로 전 구간을 다시 돌렸다.**

| 확인 | 결과 |
|---|---|
| 작업전 검수 목록 · 구성품 2줄 = 사진 칸 2개 | 대상 1건 · 칸 2개 |
| 촬영 → 저장 → 2칸 「저장됨」 → 검수완료 | `작업중` · 검수자 `현장작업` |
| 완료 검수 칸 3개 → 저장 → 완료처리 | `작업완료` · 검수자 `현장작업` |
| 저장된 사진 슬롯이 **서버 CHECK 와 같은가** | `pre/1/1` `pre/2/1` · `done/null/1~3` ✅ |
| 로그아웃 후 IndexedDB | `drafts 0` · `files 0` · 세션 null (전: drafts 1 · files 5) |
| 웹 목록 상태 · 상세 썸네일 | `작업완료` · 작업전 2장 + 완료 3장 = 5장 |

⚠️ **mock 모드는 RLS 를 타지 않는다.** ㉑㉒㉔㉕ 의 서버 잠금은 이 확인으로 증명되지 않는다 —
SQL 은 문법·의미를 눈으로 검토했을 뿐이고 **실 Supabase 적용·검증이 남아 있다** (§17-8).

### 17-8. 실서버 적용 전 확인할 것 🔑

지금 실 Supabase 에는 **4테이블(이전 판)만** 있고 검수 컬럼·`process_photos`·버킷·정책은 없다.
`20260919_processing_mobile.sql` 을 적용한 뒤 아래를 확인한다.

1. 현장작업자 계정으로 작업전 검수 → **`pre_check_at` 이 실제로 찍히는가** (㉑)
2. 같은 계정으로 작업수량 수정 시도 → `검수 권한으로는 검수 항목만 수정할 수 있습니다.` (㉑)
3. `jobs/` 밖 경로 업로드 시도 → 거부 (㉔)
4. 남의 사진 행 update 시도 → `taken_by` 가 달라 거부 (㉔)
5. `active = false` 계정의 토큰으로 사진 조회 → 0행 (㉕)
6. 마이그레이션을 **두 번** 돌려도 같은 결과인가 (멱등)

### 구현하며 확인한 것 (mock 모드 브라우저)

마스터 등록(제품 + 부자재) → 작업 등록(LOT 2행 분할 · 잔량 자동 채움 30/70) → 문서생성
(`20260919-01`) → 캘린더 막대·`+N` → 문서 나간 뒤 일정만 수정 → 완료건 삭제 거부 →
대기건 삭제(soft delete) → 제품코드 중복·제품 구분 없는 마스터 거부까지 동작을 확인했다.

---

## 열린 가정

구현 전에 대표님 확인이 필요한 항목이다. **모두 이 문서 작성자의 추정**이고 명시 지시가 아니다.

| # | 가정 | 바뀌면 영향 |
|---|---|---|
| A1 | 권한 `manageProcessing` = 관리자·용마담당자·화주관리자. 화주영업팀·현장작업자는 **조회만** | `config.js` `schema.sql` 두 줄 |
| A2 | 조회는 로그인 사용자 **모두**(등록자 제한 없음) | RLS select 정책 |
| A3 | 마스터는 **제품코드당 1건**(작업구분이 달라도 둘 수 없다) | unique 인덱스 + 작업 등록 폼에 작업구분 선택 추가 |
| A4 | 진행상태는 **저장하지 않고 계산**한다(`done_at` · `doc_created_at`) | 컬럼 1개 · `processStatus` |
| A5 | `대기 → 진행` 은 **문서생성 시 자동**, `완료` 만 수동 버튼 | 버튼 1개 |
| A6 | 필요수량·작업수량은 **정수만**(소수 없음) | 컬럼 타입 `integer` → `numeric` |
| A7 | 마스터에 없는 제품코드는 **등록 거부**(구성품 없는 작업을 만들지 않는다) | 폼 검증 + `createProcessJob` |
| A8 | 문서 생성 후에는 **일정만 수정**, 수량·구성품은 삭제 후 재등록 | `updateProcessJob` 화이트리스트 |
| A9 | 완료된 작업은 **삭제 불가**(완료취소 후 삭제) | `deleteProcessJobs` 가드 |
| A10 | 한 구성품 줄에 LOT 이 2행 이상이면 **LOT 값 필수**, 1행이면 선택 | `validateLots` |
| A11 | 캘린더 한 칸에 막대는 **최대 3개**, 나머지는 `+N` | `maxLane` 상수 |
| A12 | 유통가공작업은 **주문(orders)과 연결하지 않는다**(독립 업무) | 테이블에 `order_no` 추가 |
| A13 | 부자재관리 탭은 이번에 **플레이스홀더만** (테이블도 만들지 않는다) | 별도 설계 |

### 모바일 검수(§17)에서 더해진 가정

| # | 가정 | 바뀌면 영향 |
|---|---|---|
| A14 | **검수 권한 = `updateStatus`** (관리자·용마담당자·현장작업자). 화주관리자는 등록은 되지만 검수는 못 한다 | `db.canCheckProcessing` 1줄 + storage/RLS 정책. 새 권한 키를 만들면 `PERMISSION` 매트릭스·CLAUDE.md 표까지 |
| A15 | 상태 3단계는 **`작업대기` · `작업중` · `작업완료`** 이고 `doc_created_at` 은 상태에서 뺀다 | `processStatus` · 문서 없는 건의 구분이 「문서」 컬럼으로만 남는다 |
| A16 | **웹의 `작업완료`·`완료취소` 버튼을 없앤다.** 완료는 사진이 있는 앱 완료검수로만 | 웹에 버튼을 되살리면 증빙 없는 완료가 생긴다 |
| A17 | 검수 대상은 **`doc_no` 가 있는 작업만** (목록·입력·스캔 모두 같은 모집단) | 목록만 열면 문서 없는 건이 `작업중` 에서 막힌다(§17-1) |
| A18 | **`작업중` 인 작업은 삭제할 수 없다** (작업전검수 취소 후 삭제) | `deleteProcessJobs` 가드 1줄 |
| A19 | 작업전 사진은 **구성품 줄마다 1장**(제품·부자재 모두). LOT 행은 나누지 않는다 | `savePreCheck` 검증 · 경로 규칙 |
| A20 | 완료 사진은 **정확히 3장** (더도 덜도 안 된다) | `PROCESS_DONE_PHOTOS` 상수 1곳 |
| A21 | 사진은 **JPEG · 긴 변 1280px · 목표 200KB · 상한 1MB**. 원본은 보관하지 않는다 | `photo.js` 의 `PHOTO` 상수 · 버킷 `file_size_limit` |
| A22 | 검수·완료를 **취소해도 사진은 지우지 않는다** (다시 찍으면 덮어쓴다) | `revokePreCheck` · Storage 정리 배치 필요 여부 |
| A23 | ~~앱 탭 6번째~~ → **상단바 메뉴(`APP_MENU`) 첫 항목 「유통가공작업」** (대표님 지시 2026-09-19 · 하단 탭은 5개 유지) | `APP_MENU` 순서 1줄 |
| A24 | mock 모드 사진은 **IndexedDB** 에 둔다 (localStorage 아님) | `store.js` 파일 API · `idb.js` |

### 개발팀 주의사항 5가지 🔑

1. **상태 판정은 `db.processStatus()` 하나뿐이다.** 앱 화면이 `job.pre_check_at` 을 보고
   직접 「작업중」 을 그리면 웹과 앱의 색이 갈린다 (2026-09-16 학습로그의 재발 자리다).
   목록 함수가 붙여 주는 `status` 만 쓴다
2. **화면이 잠그는 조건을 `db.js` 에도 넣는다.** 「사진이 다 찼을 때만 검수완료」 는 표현이
   아니라 **쓰기 허용 조건**이다 (2026-09-17 학습로그). 화면 버튼과 `savePreCheck` 양쪽에 둔다
3. **Storage 경로는 결정적이어야 한다.** 랜덤 파일명·타임스탬프를 붙이면 재촬영마다 고아가
   쌓이고, `process_photos` 의 unique 도 무력해진다. 경로를 만드는 곳은 `db.js` 한 함수뿐
4. **되돌릴 수 없는 저장(업로드·`done_at`)은 실패 경로마다 `invalidate()`** 한다.
   `db` 객체는 `store.js` 캐시와 같은 객체라, 실패한 값이 남으면 다음 저장이 밀어 넣는다
5. **`render()` 정리 함수에서 `release()` 와 `URL.revokeObjectURL` 을 반드시 부른다.**
   사진 URL 은 화면마다 수십 개가 생긴다 — 안 지우면 폰에서 메모리가 샌다.
   카메라(`scanBar`)·구독 해제는 기존 관례 그대로

### A7 상세 — 마스터가 없는 제품코드

**거부를 추천한다.** 근거:

- 구성품이 없으면 작업지시서에 찍을 내용이 없다. 빈 종이가 현장에 나간다
- 구성품은 **스냅샷**이라 나중에 마스터를 만들어도 이미 등록된 작업에 자동으로 붙지 않는다.
  「나중에 채우면 된다」가 성립하지 않는다
- 상태를 바꾸는 새 동작은 **허용 조건부터 좁게** 못 박는 것이 이 저장소의 교훈이다

대신 막다른 길이 되지 않게 한다 — 제품코드 입력 즉시 조회해 없으면 폼 안에
`작업마스터에 없는 제품코드입니다.` 안내와 **「작업마스터 등록」 버튼**을 띄워
마스터 팝업을 바로 열고, 저장하면 구성품이 자동으로 채워지게 한다.
