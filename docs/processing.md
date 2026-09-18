# 유통가공작업

> 코드 `assets/js/pages/processing.js` + `assets/js/pages/processing/*.js` (웹 전용)
> 순수 계산 `assets/js/processing-calc.js`
> 라우트 `#/processing` · [공통 규약](common.md) · [CLAUDE.md](../CLAUDE.md)

창고에서 출고 전에 하는 **유통가공**(라벨 부착 · 세트 구성 · 해체)을 등록하고,
구성품(제품 + 부자재)과 LOT 을 확정해 **작업지시서**를 내는 화면.

주문 흐름(주문정보등록 → 출고주문처리 → 상차리스트)과 **연결되지 않는 독립 업무**다.
주문번호·차수·대표주문번호 개념을 쓰지 않으며, `orders` 테이블을 건드리지 않는다.
(나중에 주문과 잇게 되면 `process_jobs.order_no` 를 추가하는 것이 확장 경로다)

⚠️ **구현 완료.** 아래 [열린 가정](#열린-가정) A1~A13 은 **확인을 받지 않은 채 설계안 그대로**
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

**모바일 앱 셸(`m.html`)에는 넣지 않는다.** `MENUS` 의 `mobile: false` 이고
`APP_TABS` · `APP_MENU` 에도 추가하지 않는다 — 현장 작업이 아니라 사무 등록 업무다.

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
| `doc_created_at` | timestamptz | | 문서 생성 시각 (**진행** 판정) |
| `doc_created_by` / `_name` | uuid / text | | 문서를 낸 사람 |
| `done_at` | timestamptz | | 작업완료 시각 (**완료** 판정) |
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
export const PROCESS_STATUS = { WAIT: '대기', DOING: '진행', DONE: '완료' };
```

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

- mock 초기 구조(`mockLoad()` 의 `empty`)에 네 키를 빈 배열로 추가한다
- `db.js` 의 `normalize()` 에도 `db.processMasters = db.processMasters ?? []` … 네 줄을 넣는다
  (옛 저장 데이터를 열어도 오류가 나지 않게 한다)
- Realtime 구독은 `subscribeStore` 가 `TABLES` 를 돌며 자동으로 붙는다. 추가 작업 없음
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
| `setProcessDone(id, user)` / `revokeProcessDone(id, user)` | 완료 / 완료취소. 문서번호가 없으면 완료 불가 |
| `issueProcessDoc(id, user)` | **문서번호 채번 + `doc_created_at` 기록.** 이미 번호가 있으면 그대로 돌려준다(재생성 없음). 충돌 시 재시도 |
| `processStatus(job)` | `대기`/`진행`/`완료` — **판정의 유일한 출처** |
| `canManageProcessing(user)` | `PERMISSION[role].manageProcessing` |

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

---

## 7. 권한

`config.js` 의 `PERMISSION` 에 **`manageProcessing`** 을 추가한다.

| 권한 | 관리자 | 용마담당자 | 화주관리자 | 화주영업팀 | 현장작업자 |
|---|:---:|:---:|:---:|:---:|:---:|
| `manageProcessing` 작업·마스터 등록/수정/삭제·문서생성 | ✅ | ✅ | ✅ | ❌ | ❌ |

- **조회는 로그인 사용자 모두**다. `viewAll` 을 보지 않는다(공지사항과 같은 방식) —
  유통가공은 창고 내부 업무라 등록자별로 가릴 이유가 없다
- 화면은 `can(user, 'manageProcessing')` 로만 판정하고 역할명을 직접 비교하지 않는다
- 권한이 없으면 **등록·수정·삭제·문서생성 버튼이 아예 렌더되지 않고**,
  `db.js` 의 쓰기 함수도 같은 조건으로 거부한다(화면 잠금만 두면 db 를 직접 불러 뚫린다 —
  [AGENT_LEARNING_LOG 2026-09-17](AGENT_LEARNING_LOG.md))
- 서버 RLS 는 `can_manage_processing()` 이 같은 기준으로 막는다
- 🔑 **하드 삭제(`delete`)는 관리자만**(정책상). 앱은 `deleted_at` 만 찍는 soft delete 라
  일반 경로에서는 쓰지 않는다 — `process_masters` · `process_jobs` 의 delete 정책은
  `my_role() = 'admin'` 이다. 자식 테이블(`process_master_items` · `process_job_items`)은
  구성품을 통째로 교체할 때 DELETE 를 타므로 `can_manage_processing()` 그대로 둔다
- 소속(company)은 보지 않는다. 주문정보등록처럼 `ORDER_POLICY` 를 따로 두지 않는다

---

## 8. 진행상태 전이

```
대기 ──(작업지시서 생성)──▶ 진행 ──(완료 버튼)──▶ 완료
 ▲                          │                      │
 └───(문서 생성 전 수정·삭제)  └──(완료취소)◀─────────┘
```

| 전이 | 계기 | 저장 |
|---|---|---|
| 대기 → 진행 | **문서생성 버튼** (자동) | `doc_created_at` |
| 진행 → 완료 | 목록의 **완료** 버튼 (수동) | `done_at` |
| 완료 → 진행 | **완료취소** (수동) | `done_at = null` |

**문서생성으로 진행을 자동 전이하는 쪽을 추천한다** (근거):
① 버튼이 하나 줄어든다 — 「생성」을 누른 뒤 「진행」을 또 눌러야 하면 반드시 빠뜨리고,
문서는 나갔는데 상태는 `대기` 인 불일치가 쌓인다.
② 이 시스템은 **행동이 상태를 만든다**는 원칙으로 되어 있다(접수 = 작업지시 작성,
검수완료 = 파렛트 입력). 「작업지시서를 냈다」가 곧 「작업이 현장에 나갔다」이다.
③ 저장 필드가 곧 상태라 별도 동기화 코드가 없다.

**대기 → 완료 건너뛰기는 막는다.** 문서 없이 끝난 작업은 기록이 남지 않는다.

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
| 진행상태 | 90px | `.tag` — 대기 `gray` · 진행 `blue` · 완료 `green` |
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
| 대기 (문서 없음) | ✅ | ✅ | ✅ |
| 진행 (문서 있음) | ❌ | ✅ | ✅ (확인 문구에 문서번호를 적는다) |
| 완료 | ❌ | ❌ | ❌ (완료취소 후 삭제) |

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
- 바코드는 넣지 않는다(스캔 대상이 아니다). 필요해지면 `barcode.js` 를 그대로 쓸 수 있다

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

## 구현 시 바꾼 것 (설계안 대비)

설계서대로 구현했고, 아래 11가지만 근거를 두고 바꿨다.
(⑦ 은 코드리뷰팀이, ⑧~⑪ 은 코드리뷰·DB 감사 지적을 받아 고친 것이다)

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

필요수량 계산은 **화면도 `processing-calc.js` 의 `needQty()` 를 직접 부른다**
(`steps.js` · `checkflow.js` 와 같은 자리다 — 순수 계산 모듈은 화면이 바로 import 한다).
`db.js` 를 거쳐 다시 내보내면 같은 계산에 경로가 둘이 되어, 한쪽만 고치는 순간 값이 갈린다.

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

### A7 상세 — 마스터가 없는 제품코드

**거부를 추천한다.** 근거:

- 구성품이 없으면 작업지시서에 찍을 내용이 없다. 빈 종이가 현장에 나간다
- 구성품은 **스냅샷**이라 나중에 마스터를 만들어도 이미 등록된 작업에 자동으로 붙지 않는다.
  「나중에 채우면 된다」가 성립하지 않는다
- 상태를 바꾸는 새 동작은 **허용 조건부터 좁게** 못 박는 것이 이 저장소의 교훈이다

대신 막다른 길이 되지 않게 한다 — 제품코드 입력 즉시 조회해 없으면 폼 안에
`작업마스터에 없는 제품코드입니다.` 안내와 **「작업마스터 등록」 버튼**을 띄워
마스터 팝업을 바로 열고, 저장하면 구성품이 자동으로 채워지게 한다.
