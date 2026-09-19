-- ============================================================================
--  더퓨어랩 수출 모니터링 시스템 - Supabase 스키마
--
--  ⚠️ 이 파일이 데이터 모델의 정식 정의다. mock-data.js 도 같은 필드명을 쓴다.
--
--  설계 메모
--   1. **id 는 text 다.** 앱(`util.js` 의 `uid()`)이 만든 값을 그대로 쓴다.
--      profiles 만 auth.users 와 1:1 로 묶여야 하므로 uuid 다.
--   2. **업무 규칙을 트리거로 넣지 않는다.** 이력 기록·단계 동기화·차수 계산은
--      모두 `db.js` 가 담당한다. 양쪽에 두면 이력이 두 번 쌓인다.
--   3. 처리 단계는 숫자가 아니라 **완료 시각 필드**로 표현한다.
--      값이 있으면 완료다 (`config.js` 의 WORK_STEPS 참고).
-- ============================================================================

-- ────────────────────────────── 사용자 (profiles) ──────────────────────────────

create table if not exists public.profiles (
    id         uuid primary key references auth.users (id) on delete cascade,
    name       text        not null,
    email      text        not null,
    -- 고객사 | 용마로지스 | 협력사 (config.js 의 COMPANY)
    company    text        not null,
    -- admin | yongma | shipper_admin | shipper_sales | worker (config.js 의 ROLE)
    role       text        not null,
    phone      text        not null default '',
    active     boolean     not null default true,
    created_at timestamptz not null default now()
);

comment on table public.profiles is '사용자. auth.users 와 1:1 로 묶인다';

-- ──────────────────────────────── 권한 판정 함수 ────────────────────────────────
-- RLS 정책이 profiles 를 읽어야 하는데, 정책 안에서 같은 테이블을 조회하면
-- 재귀가 걸린다. security definer 함수로 우회한다.
-- 권한 구분은 config.js 의 PERMISSION 매트릭스와 같아야 한다.

create or replace function public.my_role()
    returns text language sql stable security definer set search_path = public as $$
    select role from public.profiles where id = auth.uid() and active
$$;

create or replace function public.my_company()
    returns text language sql stable security definer set search_path = public as $$
    select company from public.profiles where id = auth.uid() and active
$$;

/* 전체 조회 - 화주영업팀만 본인 등록건으로 제한된다 */
create or replace function public.can_view_all()
    returns boolean language sql stable as $$
    select public.my_role() in ('admin', 'yongma', 'shipper_admin', 'worker')
$$;

/* 주문 등록·수정 */
create or replace function public.can_write_order()
    returns boolean language sql stable as $$
    select public.my_role() in ('admin', 'shipper_admin', 'shipper_sales')
$$;

/* 공지사항 등록·수정·삭제 (config.js 의 manageNotice) */
create or replace function public.can_manage_notice()
    returns boolean language sql stable as $$
    select public.my_role() in ('admin', 'yongma')
$$;

/* 업무체크리스트 항목 등록·수정·삭제 (config.js 의 manageChecklist) */
create or replace function public.can_manage_checklist()
    returns boolean language sql stable as $$
    select public.my_role() in ('admin', 'yongma', 'shipper_admin')
$$;

/* 출고·검수·적치·상차 처리 */
create or replace function public.can_update_status()
    returns boolean language sql stable as $$
    select public.my_role() in ('admin', 'yongma', 'worker')
$$;

/* 출고 완료처리 */
create or replace function public.can_close_order()
    returns boolean language sql stable as $$
    select public.my_role() in ('admin', 'yongma')
$$;

/* 이슈 등록 */
create or replace function public.can_create_issue()
    returns boolean language sql stable as $$
    select public.my_role() in ('admin', 'yongma', 'shipper_admin', 'shipper_sales')
$$;

/* 접수/수정/조정 확인 체크 - 주문정보등록 화면은 소속까지 본다 (ORDER_POLICY.confirm) */
create or replace function public.can_confirm_order()
    returns boolean language sql stable as $$
    select public.my_role() in ('admin', 'shipper_admin')
        or public.my_company() = '용마로지스'
$$;

-- ───────────────────────────────── 주문 (orders) ─────────────────────────────────

create table if not exists public.orders (
    id                text        primary key,
    reg_date          date        not null default current_date,   -- 등록일자
    send_date         date        not null,                        -- 전송일자
    seq               int         not null default 1,              -- 차수
    order_no          text        not null,                        -- 주문번호
    -- 추가주문 묶음의 기준 번호. 1차수는 자기 주문번호와 같다.
    -- 상차(당일상차리스트·상차검수)는 이 값으로 차수를 묶는다.
    base_no           text        not null,
    -- 대표주문번호 (여러 주문번호를 한 검수·상차 단위로 묶는다. 없으면 null)
    rep_no            text,
    customer          text        not null,                        -- 거래처명
    ship_req_date     date,                                        -- 출고요청일 (null 이면 미정)
    team_name         text        not null default '',             -- 팀명
    vehicle_type      text        not null default '용차',          -- 출고형태: 용차 | 픽업 | 택배
    region            text        not null default '국내',          -- 구분: 국내 | 해외
    extra_yn          text        not null default '없음',          -- 추가작업: 있음 | 없음
    packing_yn        text        not null default '없음',          -- 패킹리스트: 있음 | 없음
    work_note         text        not null default '',             -- 접수 시 작성하는 작업지시
    packing_note      text        not null default '',             -- 패킹리스트 내용 (있음인 주문만 작성)
    extra_works       text[]      not null default '{}',           -- (구) 추가작업 다중 선택 - 옛 데이터용
    request_note      text        not null default '',
    remark            text        not null default '',

    -- 수량 - 품목수/출고수량은 아직 입력 경로가 없다 (CLAUDE.md 열린 이슈 1번)
    item_count        int         not null default 0,
    qty               int         not null default 0,
    -- 파렛트수·박스수는 검수작업 탭에서 실측값을 수기 입력한다
    pallet_count      int         not null default 0,
    box_count         int         not null default 0,
    edit_count        int         not null default 0,              -- 수정 횟수

    -- ── 처리 단계별 완료 시각 (값이 있으면 완료) ──
    confirmed_at      timestamptz,                                 -- 주문처리 (접수 체크)
    confirmed_by      uuid        references public.profiles (id),
    confirmed_by_name text        not null default '',
    ship_started_at   timestamptz,                                 -- 출고작업 시작
    ship_done_at      timestamptz,                                 -- 출고작업 완료
    req_work_at       timestamptz,                                 -- 요청작업 (조건부)
    packing_at        timestamptz,                                 -- 패킹리스트 확인
    inspect_done_at   timestamptz,                                 -- 검수작업
    stow_done_at      timestamptz,                                 -- 출고적치
    extra_done_at     timestamptz,                                 -- 추가작업 (조건부)
    loaded_at         timestamptz,                                 -- 상차작업
    -- 단계가 아니라 마감 표시. 주문처리현황의 탭을 가르는 기준이다
    closed_at         timestamptz,

    -- ── 취소 ──
    canceled_at       timestamptz,
    canceled_by       uuid        references public.profiles (id),
    canceled_by_name  text        not null default '',

    -- ── 단계별 작업자 이름 (스캔해서 작업을 연 사람이 기록된다) ──
    ship_worker       text        not null default '',
    inspect_worker    text        not null default '',
    extra_worker      text        not null default '',

    -- ── 상차 검수 ──
    inspected         int         not null default 0,              -- 검수된 파렛트 수
    load_status       text        not null default '대기',          -- 대기 | 검수 | 완료

    created_by        uuid        not null references public.profiles (id),
    created_at        timestamptz not null default now()
);

create index if not exists orders_base_no_idx   on public.orders (base_no);
create index if not exists orders_rep_no_idx    on public.orders (rep_no) where rep_no is not null;
create index if not exists orders_order_no_idx  on public.orders (order_no);
create index if not exists orders_ship_date_idx on public.orders (ship_req_date);
create index if not exists orders_created_by_idx on public.orders (created_by);

-- ─────────────────────────── 변동사항 이력 (order_history) ───────────────────────────

create table if not exists public.order_history (
    id              text        primary key,
    order_id        text        not null,
    -- 몇 번째 수정에서 생긴 변경인지. 0 이면 수정이 아닌 이벤트(등록·단계 처리 등)
    rev             int         not null default 0,
    field           text        not null,                          -- 항목명 (한글 라벨)
    before          text        not null default '',
    after           text        not null default '',
    memo            text        not null default '',
    changed_by      uuid        references public.profiles (id),
    changed_by_name text        not null default '',
    changed_at      timestamptz not null default now(),
    -- 수정확인 (용마로지스 담당자가 확인 처리)
    checked_at      timestamptz,
    checked_by      uuid        references public.profiles (id),
    checked_by_name text        not null default ''
);

create index if not exists history_order_idx on public.order_history (order_id);

-- 주문이 지워지면 이력도 함께 지운다 (order_id 는 text 라 FK 대신 트리거로 정리)
create or replace function public.cleanup_order_children()
    returns trigger language plpgsql security definer set search_path = public as $$
begin
    delete from public.order_history    where order_id = old.id;
    delete from public.restore_requests where order_id = old.id;
    delete from public.pallets          where order_id = old.id;
    return old;
end;
$$;

drop trigger if exists trg_cleanup_order_children on public.orders;
create trigger trg_cleanup_order_children
    before delete on public.orders
    for each row execute function public.cleanup_order_children();

-- ────────────────────────── 파렛트 (pallets) - 검수 · 적치 ──────────────────────────

create table if not exists public.pallets (
    id         text        primary key,
    order_id   text        not null,
    barcode    text        not null,                               -- {주문번호}-P01
    scanned_at timestamptz,                                        -- 상차 검수 스캔 시각
    location   text        not null default '',                    -- 적치 로케이션 (IF-01-03-01)
    picked_at  timestamptz                                         -- 적치 위치에서 내린 시각
);

create index if not exists pallets_order_idx on public.pallets (order_id);

-- ─────────────────────────── 조정요청 (restore_requests) ───────────────────────────

create table if not exists public.restore_requests (
    id              text        primary key,
    order_id        text        not null,
    type            text        not null default 'email',          -- email | form
    category        text        not null default 'etc',            -- ADJUST_CATEGORIES 의 key
    reason          text        not null default '',
    product_code    text        not null default '',
    qty             text        not null default '',
    created_by      uuid        references public.profiles (id),
    created_by_name text        not null default '',
    created_at      timestamptz not null default now(),
    -- 요청확인 (확인되면 현장 작업 대상이 된다)
    checked_at      timestamptz,
    checked_by      uuid        references public.profiles (id),
    checked_by_name text        not null default ''
);

create index if not exists restores_order_idx on public.restore_requests (order_id);

-- ──────────────────────────────── 이슈 (issues) ────────────────────────────────
-- 유형이 '작업요청' 인 건은 주문번호로 이어 붙여 추가작업 요청으로 쓴다
-- (config.js 의 EXTRA_TASK_TYPE).

create table if not exists public.issues (
    id            text        primary key,
    type          text        not null,                            -- 업무구분: 오류확인|긴급작업|정보확인|자료요청|작업요청|기타업무
    work_type     text        not null default '',                 -- 업무유형: 입고|출고|반품|배송|배차|기타
    title         text        not null,
    order_no      text        not null default '',
    content       text        not null default '',
    due_date      date,
    status        text        not null default '접수대기',          -- 접수대기|접수완료|확인중|종결요청|종결완료
    assignee_id   uuid        references public.profiles (id),     -- 확인담당자 (이슈접수 시 지정)
    assignee_name text        not null default '',
    closed_at     timestamptz,                                     -- 종결일자 (종결승인 시 기록)
    canceled_at   timestamptz,                                     -- 취소일자 (확인취소 시 기록)
    auto_created  boolean     not null default false,              -- 조정요청 접수 시 자동등록된 건
    created_by    uuid        references public.profiles (id),
    created_at    timestamptz not null default now()
);

create index if not exists issues_order_no_idx on public.issues (order_no);

-- 이미 만들어진 환경 재적용용 - create table if not exists 는 컬럼을 추가하지 않으므로 병기한다
alter table public.orders add column if not exists team_name  text not null default '';
alter table public.orders add column if not exists region     text not null default '국내';
alter table public.orders add column if not exists extra_yn   text not null default '없음';
alter table public.orders add column if not exists packing_yn text not null default '없음';
alter table public.orders add column if not exists work_note  text not null default '';
alter table public.orders add column if not exists packing_note text not null default '';
-- 대표주문번호 - 여러 주문번호를 한 검수·상차 단위로 묶는다 (null 허용)
alter table public.orders add column if not exists rep_no     text;
create index if not exists orders_rep_no_idx on public.orders (rep_no) where rep_no is not null;
alter table public.orders alter column ship_req_date drop not null;

alter table public.issues add column if not exists assignee_id   uuid references public.profiles (id);
alter table public.issues add column if not exists assignee_name text not null default '';
alter table public.issues add column if not exists closed_at     timestamptz;
alter table public.issues add column if not exists work_type     text not null default '';
alter table public.issues add column if not exists auto_created  boolean not null default false;
alter table public.issues add column if not exists canceled_at   timestamptz;
alter table public.issues alter column status set default '접수대기';

-- ─────────────────────────── 이슈 댓글 (issue_comments) ───────────────────────────
-- 이슈 상세 팝업의 댓글. parent_id 로 대댓글이 이어진다.
-- 답글이 달린 댓글을 지우면 글만 비우고(soft delete) 스레드는 유지한다.

create table if not exists public.issue_comments (
    id              text        primary key,
    issue_id        text        not null references public.issues (id) on delete cascade,
    parent_id       text        references public.issue_comments (id),
    content         text        not null default '',
    created_by      uuid        references public.profiles (id),
    created_by_name text        not null default '',
    created_at      timestamptz not null default now(),
    updated_at      timestamptz,                                   -- 수정 시각 (있으면 '수정됨' 표시)
    deleted_at      timestamptz                                    -- 삭제 시각 (있으면 내용 감춤)
);

create index if not exists issue_comments_issue_idx on public.issue_comments (issue_id);

-- ────────────────────────────── 공지사항 (notices) ──────────────────────────────
-- 화주·물류사 전체에 알리는 게시판. 조회는 로그인 사용자 모두, 작성은 관리자·용마담당자.
-- 중요공지(important)는 목록 맨 위에 고정된다.
-- 삭제는 댓글 스레드를 남기려고 행을 지우지 않고 deleted_at 만 찍는다(soft delete).

create table if not exists public.notices (
    id              text        primary key,
    title           text        not null,
    content         text        not null default '',
    important       boolean     not null default false,   -- 중요공지 (목록 상단 고정)
    created_by      uuid        references public.profiles (id),
    created_by_name text        not null default '',
    created_at      timestamptz not null default now(),
    updated_at      timestamptz,                          -- 수정 시각 (있으면 '수정됨' 표시)
    deleted_at      timestamptz                           -- 삭제 시각 (있으면 목록에서 제외)
);

comment on table public.notices is '공지사항. 등록·수정·삭제는 관리자·용마담당자만';

create index if not exists notices_created_idx on public.notices (created_at desc);

-- ─────────────────────────── 공지 댓글 (notice_comments) ───────────────────────────
-- 구조와 규칙은 issue_comments 와 같다. 수정·삭제만 본인 또는 관리자로 넓혔다.

create table if not exists public.notice_comments (
    id              text        primary key,
    notice_id       text        not null references public.notices (id) on delete cascade,
    parent_id       text        references public.notice_comments (id),
    content         text        not null default '',
    created_by      uuid        references public.profiles (id),
    created_by_name text        not null default '',
    created_at      timestamptz not null default now(),
    updated_at      timestamptz,                          -- 수정 시각 (있으면 '수정됨' 표시)
    deleted_at      timestamptz                           -- 삭제 시각 (있으면 내용 감춤)
);

create index if not exists notice_comments_notice_idx on public.notice_comments (notice_id);

-- ─────────────────────── 업무체크리스트 항목 (checklist_items) ───────────────────────
-- 업무구분(division) → 업무항목(group) → 프로세스(process) → 체크항목(check)/상황(situation) 트리.
-- 최상위는 업무구분뿐이고 사용자가 만든다. parent_id 로 하위 항목이 이어진다.
-- 체크 대상은 체크항목과 하위가 없는 프로세스이고, 상황 노드의 체크 기록은 「발생」이다.
-- 주기 판정(일·주·월·수시, 말일 보정)은 db.js 의 dueItems() 한 곳에서만 한다.
-- 삭제는 체크 기록을 남기려고 행을 지우지 않고 deleted_at 만 찍는다(soft delete).

create table if not exists public.checklist_items (
    id              text        primary key,
    category        text        not null,                     -- 업무항목 이름 (옛 컬럼 · 화면 로직은 안 쓴다)
    parent_id       text        references public.checklist_items (id),
    kind            text        not null default 'check'      -- config.js 의 CHECK_KIND
                                check (kind in ('division', 'group', 'process', 'situation', 'check')),
    child_flow      text        not null default 'seq'        -- 하위 프로세스 연결 방식 (CHECK_FLOW)
                                check (child_flow in ('seq', 'fork', 'join')),
    title           text        not null,
    description     text        not null default '',
    cycle           text        not null default 'daily'
                                check (cycle in ('daily', 'weekly', 'monthly', 'adhoc')),
    weekday         smallint    check (weekday between 0 and 6),   -- 주 - 0=일
    monthday        smallint    check (monthday between 1 and 31), -- 월 - 말일은 보정된다
    assignee_id     uuid        references public.profiles (id),   -- 정담당자
    assignee_name   text        not null default '',
    sub_assignees   jsonb       not null default '[]'::jsonb,    -- 부담당자 여러 명 [{id, name}]
    sort_order      integer     not null default 0,           -- 형제 사이의 표시 순서
    active          boolean     not null default true,
    daily           boolean     not null default false,       -- 일일체크리스트 포함 (업무프로세스 탭에서 체크)
    created_by      uuid        references public.profiles (id),
    created_by_name text        not null default '',
    created_at      timestamptz not null default now(),
    updated_at      timestamptz,
    deleted_at      timestamptz,                              -- 삭제 시각 (있으면 목록에서 제외)
    legacy_parent_id text                                      -- 독립 체크항목 이행 전 parent_id (롤백용)
);

comment on table public.checklist_items is '업무체크리스트 흐름 트리(프로세스·상황·체크항목). 등록·수정·삭제는 manageChecklist 권한';

-- 기존 구축분에 종류(kind) 컬럼 추가. 하위가 있는 옛 항목은 프로세스, 없으면 체크항목으로 본다
alter table public.checklist_items add column if not exists kind text not null default 'check';
alter table public.checklist_items drop constraint if exists checklist_items_kind_check;
alter table public.checklist_items add constraint checklist_items_kind_check
    check (kind in ('division', 'group', 'process', 'situation', 'check'));
update public.checklist_items i set kind = 'process'
 where i.kind = 'check'
   and exists (select 1 from public.checklist_items c where c.parent_id = i.id);

-- 하위 프로세스 연결 방식(순차/갈래/합류). 기본값이 'seq' 라 기존 데이터는 지금과 똑같이 그려진다
-- 'join' 은 갈래를 벌린 뒤 다음 형제 한 단계로 다시 모으는 값이다 (나중에 추가)
alter table public.checklist_items add column if not exists child_flow text not null default 'seq';
alter table public.checklist_items drop constraint if exists checklist_items_child_flow_check;
alter table public.checklist_items add constraint checklist_items_child_flow_check
    check (child_flow in ('seq', 'fork', 'join'));

-- 일일체크리스트 포함 여부. 컬럼이 없던 시절의 항목은 모두 포함으로 본다 (화면에서 끌 수 있다)
alter table public.checklist_items add column if not exists daily boolean not null default false;
-- 부담당자(여러 명) - 정담당자와 한 묶음으로 상속된다 (db.js effectiveAssignee · 아래 checklist_can_check)
alter table public.checklist_items add column if not exists sub_assignees jsonb not null default '[]'::jsonb;
-- 독립 체크항목 이행 전 parent_id 백업 (롤백용). 값이 있으면 이미 이행된 항목이라 이행 블록을 건너뛴다
alter table public.checklist_items add column if not exists legacy_parent_id text;
update public.checklist_items set daily = true
 where kind in ('check', 'process') and daily = false and updated_at is null
   and created_at < '2026-09-09T02:00:00Z';

-- 고정 구분(입고·출고·반품·기타) 시절의 최상위 항목을 업무항목(group) 아래로 옮긴다.
-- 업무항목이 아닌 최상위 항목의 category 마다 업무항목 한 개를 만들고 그 밑에 붙인다.
insert into public.checklist_items (id, category, parent_id, kind, title, sort_order, created_at)
select 'ci_grp_' || md5(o.category), o.category, null, 'group', o.category,
       row_number() over (order by min(o.sort_order), o.category), now()
  from public.checklist_items o
 where o.parent_id is null and o.kind <> 'group' and o.deleted_at is null
 group by o.category
on conflict (id) do nothing;
update public.checklist_items o set parent_id = 'ci_grp_' || md5(o.category)
 where o.parent_id is null and o.kind <> 'group';

-- 업무구분(division) 도입 - 업무구분 없이 최상위에 있던 업무항목마다 같은 이름의 업무구분을
-- 만들어 그 아래로 옮긴다 (입고 › 입고). 이름은 화면에서 바꾼다.
insert into public.checklist_items (id, category, parent_id, kind, title, sort_order, created_at)
select 'ci_div_' || md5(g.title), g.title, null, 'division', g.title, g.sort_order, now()
  from public.checklist_items g
 where g.parent_id is null and g.kind = 'group' and g.deleted_at is null
on conflict (id) do nothing;
update public.checklist_items g set parent_id = 'ci_div_' || md5(g.title)
 where g.parent_id is null and g.kind = 'group';

/*
 * 담당자 상속 🔑 - 자기 담당자가 없으면 가장 가까운 상위의 담당자. 끝까지 없으면 null(공통).
 * db.js 의 effectiveAssignee() 와 같은 규칙이다. 체크 RLS 가 이 값으로 판정한다.
 */
create or replace function public.checklist_effective_assignee(p_item text)
    returns uuid language sql stable as $$
    with recursive up as (
        select id, parent_id, assignee_id, 0 as depth
          from public.checklist_items where id = p_item
        union all
        select i.id, i.parent_id, i.assignee_id, up.depth + 1
          from public.checklist_items i join up on i.id = up.parent_id
         where up.depth < 50
    )
    select assignee_id from up where assignee_id is not null order by depth limit 1
$$;

/**
 * 이 항목을 로그인 사용자가 체크할 수 있는지 🔑 - db.js 의 canCheckItem() 과 같은 규칙.
 * 가장 가까운 상위 중 정담당자나 부담당자가 있는 곳의 담당자 묶음을 본다.
 *   관리 권한자  또는  담당자 없음(공통)  또는  정담당자 본인  또는  부담당자 중 한 명
 */
create or replace function public.checklist_can_check(p_item text)
    returns boolean language sql stable as $$
    with recursive up as (
        select id, parent_id, assignee_id, sub_assignees, 0 as depth
          from public.checklist_items where id = p_item
        union all
        select i.id, i.parent_id, i.assignee_id, i.sub_assignees, up.depth + 1
          from public.checklist_items i join up on i.id = up.parent_id
         where up.depth < 50
    ), eff as (
        select assignee_id, coalesce(sub_assignees, '[]'::jsonb) as subs
          from up
         where assignee_id is not null or jsonb_array_length(coalesce(sub_assignees, '[]'::jsonb)) > 0
         order by depth limit 1
    )
    select public.can_manage_checklist()
        or not exists (select 1 from eff)
        or exists (select 1 from eff e where e.assignee_id = auth.uid())
        or exists (select 1 from eff e, jsonb_array_elements(e.subs) s
                    where (s->>'id')::uuid = auth.uid())
$$;

-- ═══════════════ 이행: 프로세스 아래 체크항목 → 독립 체크항목 (기존 구축분 1회 실행) ═══════════════
-- 실행은 부장이 결과를 보면서 한다. dev-team 커밋에는 SQL 만 포함하고 여기서 자동 실행하지 않는다.
-- 대상: kind='check' · parent_id is not null · deleted_at is null · legacy_parent_id is null(멱등 - 이미
--       이행된 항목은 legacy_parent_id 가 채워져 있어 다시 안 걸린다) ·
--       **상황(kind='situation')과 그 하위 전체 제외** (상황 발생 시 같이 끼어드는 항목이라 트리에 둔다)
-- 순서: ⓪ 백업표 → ① 사전 확인 → ② 담당자 bake → ③ category 채우고 parent_id 끊기 → ④ 사후 확인
--       필요하면 ⑤ 롤백(백업표에서 복원)
-- 🔑 도우미 함수를 만들지 않는다. 지우는 것을 잊으면 스키마에 남으므로 세션 temp 표로 대상을 고정한다.

-- 상황과 그 하위 전체 - 제외 집합
create temp table _cl_sit as
with recursive down as (
    select id from public.checklist_items where kind = 'situation'
    union all
    select i.id from public.checklist_items i join down d on i.parent_id = d.id
)
select id from down;

-- 이행 대상 - 한 번 만들어 모든 단계가 같은 집합을 본다 (③ 이 parent_id 를 끊어도 흔들리지 않는다)
create temp table _cl_tgt as
select c.id, c.parent_id, c.assignee_id, c.sub_assignees
  from public.checklist_items c
 where c.kind = 'check'
   and c.parent_id is not null
   and c.deleted_at is null
   and c.legacy_parent_id is null
   and c.id not in (select id from _cl_sit);

-- ⓪ 백업표 - bake 전에 만든다. 날짜는 실행일로 바꾼다 (⑤ 롤백이 이 표에서 복원한다)
create table if not exists public._cl_mig_bak_20260918 as
select c.id, c.parent_id, c.category, c.assignee_id, c.assignee_name, c.sub_assignees
  from public.checklist_items c
  join _cl_tgt t on t.id = c.id;

-- ① 사전 확인 - 대상 · 자기 담당 없음(bake 대상) · 상황 하위라 제외된 건 · group 조상이 없는 건
select
    (select count(*) from _cl_tgt)                                                as 대상건수,
    (select count(*) from _cl_tgt t
      where t.assignee_id is null
        and jsonb_array_length(coalesce(t.sub_assignees, '[]'::jsonb)) = 0)       as 자기담당없음,
    (select count(*) from public.checklist_items c
      where c.kind = 'check' and c.parent_id is not null and c.deleted_at is null
        and c.legacy_parent_id is null and c.id in (select id from _cl_sit))      as 상황하위제외,
    (select count(*) from _cl_tgt t
      left join lateral (
          with recursive up as (
              select i.id, i.parent_id, i.kind, i.title, 0 as depth
                from public.checklist_items i where i.id = t.parent_id
              union all
              select i.id, i.parent_id, i.kind, i.title, up.depth + 1
                from public.checklist_items i join up on i.id = up.parent_id
               where up.depth < 50
          )
          select title from up where kind = 'group' order by depth limit 1
      ) g on true
      where g.title is null)                                                     as group조상없음;

-- ② 담당자 bake 🔑 - **정·부가 모두 비어 있는 항목만** 고친다.
--    부담당자만 지정된 항목까지 덮어쓰면 그 항목의 sub_assignees 가 상위 값으로 날아간다.
--    상위 체인에서 정 또는 부가 있는 **가장 가까운** 항목의 담당 묶음(정·부 함께)을 복사한다.
with recursive up as (
    select t.id as target_id, i.id, i.parent_id,
           i.assignee_id, i.assignee_name, i.sub_assignees, 0 as depth
      from _cl_tgt t
      join public.checklist_items i on i.id = t.parent_id
     where t.assignee_id is null
       and jsonb_array_length(coalesce(t.sub_assignees, '[]'::jsonb)) = 0
    union all
    select up.target_id, i.id, i.parent_id,
           i.assignee_id, i.assignee_name, i.sub_assignees, up.depth + 1
      from public.checklist_items i
      join up on i.id = up.parent_id
     where up.depth < 50
), picked as (
    select distinct on (target_id) target_id, assignee_id, assignee_name, sub_assignees
      from up
     where assignee_id is not null
        or jsonb_array_length(coalesce(sub_assignees, '[]'::jsonb)) > 0
     order by target_id, depth
)
update public.checklist_items t
   set assignee_id = p.assignee_id,
       assignee_name = p.assignee_name,
       sub_assignees = coalesce(p.sub_assignees, '[]'::jsonb)
  from picked p
 where t.id = p.target_id;

-- ③ category = 가장 가까운 group 조상의 title, legacy_parent_id = 원래 parent_id, parent_id = null
--    🔑 group 조상이 없어도 이행한다 (없으면 기존 category 를 그대로 둔다). 여기서 빠지면
--    트리에서 끊기지 않아 보드에도 안 나오고 업무프로세스에도 남는 유령 항목이 된다.
--    (서버가 lateral 안의 recursive 참조를 거부하면 ① 과 같은 재귀로 group title 을 temp 표에
--     먼저 담고 left join 으로 바꿔 쓴다 - 결과는 같다)
update public.checklist_items t
   set legacy_parent_id = t.parent_id,
       category = coalesce(g.title, t.category),
       parent_id = null
  from _cl_tgt x
  left join lateral (
      with recursive up as (
          select i.id, i.parent_id, i.kind, i.title, 0 as depth
            from public.checklist_items i where i.id = x.parent_id
          union all
          select i.id, i.parent_id, i.kind, i.title, up.depth + 1
            from public.checklist_items i join up on i.id = up.parent_id
           where up.depth < 50
      )
      select title from up where kind = 'group' order by depth limit 1
  ) g on true
 where t.id = x.id;

-- ④ 사후 확인 - 이행된 독립 체크항목 수 · 트리에 남은 체크항목 수(상황 하위 - 남아 있어야 정상)
select
    count(*) filter (where kind = 'check' and parent_id is null and legacy_parent_id is not null) as 이행됨,
    count(*) filter (where kind = 'check' and parent_id is not null)                              as 트리에_남은_체크항목
  from public.checklist_items where deleted_at is null;

-- ④-2 옛 체크 기록 점검 - 주·월 항목의 기록은 **기간 시작일**(주=월요일, 월=1일)에 있어야 한다.
--     보드(`checklistBoard`)가 기간 시작일로만 찾으므로 어긋난 기록은 미체크로 보인다.
select ch.item_id, i.title, i.cycle, ch.check_date
  from public.checklist_checks ch
  join public.checklist_items i on i.id = ch.item_id
 where i.cycle in ('weekly', 'monthly')
   and ch.check_date <> case i.cycle
       when 'weekly' then ch.check_date - (extract(isodow from ch.check_date)::int - 1)
       else date_trunc('month', ch.check_date)::date end
 order by i.cycle, ch.check_date;

-- ④-3 (어긋난 기록이 있을 때만) 기간 시작일로 정규화.
--     ⚠️ unique(item_id, check_date) 가 있어 같은 기간에 두 건이 있으면 충돌한다.
--     먼저 늦게 찍힌 중복을 지우고 나서 옮긴다.
-- delete from public.checklist_checks ch
--  using public.checklist_checks o, public.checklist_items i
--  where i.id = ch.item_id and i.cycle in ('weekly', 'monthly') and o.item_id = ch.item_id
--    and o.id <> ch.id and ch.checked_at < o.checked_at
--    and date_trunc('month', o.check_date) = date_trunc('month', ch.check_date);
-- update public.checklist_checks ch
--    set check_date = case i.cycle
--        when 'weekly' then ch.check_date - (extract(isodow from ch.check_date)::int - 1)
--        else date_trunc('month', ch.check_date)::date end
--   from public.checklist_items i
--  where i.id = ch.item_id and i.cycle in ('weekly', 'monthly');

drop table _cl_tgt;
drop table _cl_sit;

-- ⑤ 롤백 (필요할 때만 실행) - 백업표에서 parent_id·category·담당자를 그대로 되돌린다
-- update public.checklist_items t
--    set parent_id = b.parent_id, legacy_parent_id = null, category = b.category,
--        assignee_id = b.assignee_id, assignee_name = b.assignee_name,
--        sub_assignees = coalesce(b.sub_assignees, '[]'::jsonb)
--   from public._cl_mig_bak_20260918 b
--  where t.id = b.id;

create index if not exists checklist_items_cat_idx
    on public.checklist_items (category, sort_order);
create index if not exists checklist_items_parent_idx on public.checklist_items (parent_id);
create index if not exists checklist_items_assignee_idx on public.checklist_items (assignee_id);

-- ─────────────────────── 업무체크리스트 체크 (checklist_checks) ───────────────────────
-- 항목 1건을 그 날짜에 처리했다는 기록. 체크 해제는 행 삭제다.
-- 상황(kind='situation') 노드에 남긴 기록은 **그 날짜에 그 상황이 발생했다**는 뜻이고
-- memo 가 발생 내용이다 (별도 테이블을 두지 않는다).
-- 🔑 항목·날짜당 1건이라 unique 로 못 박는다 (두 사람이 같이 눌러도 한 건만 남는다).

create table if not exists public.checklist_checks (
    id              text        primary key,
    item_id         text        not null
                                references public.checklist_items (id) on delete cascade,
    check_date      date        not null,
    memo            text        not null default '',
    checked_by      uuid        references public.profiles (id),
    checked_by_name text        not null default '',
    checked_at      timestamptz,                              -- null = 미체크(메모만 있는 행)
    unique (item_id, check_date)
);

-- 기존 구축분: 메모만 남기고 체크는 안 한 행을 표현하려면 checked_at 이 비어 있어야 한다
alter table public.checklist_checks alter column checked_at drop not null;
alter table public.checklist_checks alter column checked_at drop default;

create index if not exists checklist_checks_date_idx on public.checklist_checks (check_date);

-- ─────────────────── 업무 흐름 간선 (checklist_edges) 🔑 ───────────────────
-- 소유(parent_id)와 흐름(간선)을 나눈다. parent_id·sort_order 는 **소유**만 맡고
-- (업무항목 소속 · 담당자 상속 · 삭제 전파 · RLS), **흐름 순서는 이 표가 유일한 출처**다.
-- 그래서 담당자 상속(checklist_effective_assignee)·체크 권한(checklist_can_check)·
-- 일일 판정(db.js dailyFlow)은 이 표를 보지 않는다 - 바뀌는 것은 프로세스 번호뿐이다.
--
--   from_id is null   흐름의 시작(entry)
--   group_id          흐름 한 벌의 경계 = 업무항목(group) 1개. 다른 업무항목과는 잇지 않는다
--   label             조건 라벨 (「국내」 「수량 오류 시」)
--   sort_order        같은 from 의 갈래 좌→우 순서
--
-- 순환(cycle)·자기참조·중복·다른 업무항목 간선은 db.addProcessEdge() 가 넣을 때 막는다.
-- 단계(프로세스)를 지우면 db.deleteChecklistItem() 이 앞뒤 간선을 데카르트곱으로 이어
-- 흐름이 끊기지 않게 한다. 항목은 soft delete 지만 간선은 실제로 지운다.

create table if not exists public.checklist_edges (
    id              text        primary key,
    group_id        text        not null
                                references public.checklist_items (id) on delete cascade,
    from_id         text        references public.checklist_items (id) on delete cascade,
    to_id           text        not null
                                references public.checklist_items (id) on delete cascade,
    label           text        not null default '',
    sort_order      integer     not null default 0,
    created_by      uuid        references public.profiles (id),
    created_by_name text        not null default '',
    created_at      timestamptz not null default now(),
    unique (from_id, to_id)
);

comment on table public.checklist_edges is '업무 흐름 간선(DAG). 업무항목 안의 프로세스 순서는 이 표가 유일한 출처. 편집은 manageChecklist 권한';

-- 시작 간선(from_id is null)은 unique (from_id, to_id) 로는 막히지 않는다
-- (Postgres 는 unique 에서 null 을 서로 다른 값으로 본다) - 부분 인덱스로 한 번 더 막는다
create unique index if not exists checklist_edges_entry_uniq
    on public.checklist_edges (to_id) where from_id is null;
create index if not exists checklist_edges_group_idx on public.checklist_edges (group_id, sort_order);
create index if not exists checklist_edges_from_idx  on public.checklist_edges (from_id);
create index if not exists checklist_edges_to_idx    on public.checklist_edges (to_id);

-- ══════════ 기존 구축분 1회 실행 - sort_order 사슬을 간선으로 옮긴다 ══════════
-- 🔑 parent_id · sort_order 는 **건드리지 않는다.** 되돌리려면 간선 테이블을 비우면 된다
-- (화면이 간선을 무시하면 종전 sort_order 흐름으로 돌아간다).
--
-- 업무항목별로 프로세스를 **선위순회(preorder)** 로 한 줄로 편 뒤 이웃끼리 잇는다.
-- 지금 화면이 그리는 순서와 같다:
--   평평한 형제 사슬        null→c1, c1→c2, …
--   중첩(process 밑 process) P→c1, c1→…→cn, cn→(P 의 다음 형제)
-- 상황(situation) 아래 대응 프로세스는 **넣지 않는다** - 상황은 그날 생긴 일이라
-- 늘 있는 경로(간선)와 다르고, 지금처럼 트리 + sort_order 사슬로 남는다.
--
-- 이미 간선이 있는 업무항목은 건드리지 않아 여러 번 실행해도 안전하다.

with recursive ranked as (
    select i.id, i.parent_id, i.kind,
           row_number() over (partition by i.parent_id
                              order by i.sort_order, i.created_at, i.id) as ord
      from public.checklist_items i
     where i.deleted_at is null
), walk as (
    -- 업무항목(group) 바로 아래 프로세스가 흐름의 시작이다
    select r.id, g.id as group_id, array[r.ord] as path
      from ranked r
      join public.checklist_items g on g.id = r.parent_id
     where r.kind = 'process' and g.kind = 'group' and g.deleted_at is null
    union all
    -- 프로세스 아래 프로세스만 따라 내려간다 (상황 아래로는 내려가지 않는다)
    select r.id, w.group_id, w.path || r.ord
      from walk w
      join ranked r on r.parent_id = w.id
     where r.kind = 'process' and array_length(w.path, 1) < 20
), ordered as (
    -- 배열 비교가 곧 선위순회 순서다 ([1] < [1,1] < [1,2] < [2])
    select group_id, id, row_number() over (partition by group_id order by path) as pos
      from walk
)
insert into public.checklist_edges (id, group_id, from_id, to_id, label, sort_order, created_at)
select 'ce_mig_' || md5(o.group_id || ':' || o.id), o.group_id, p.id, o.id, '', 0, now()
  from ordered o
  left join ordered p on p.group_id = o.group_id and p.pos = o.pos - 1
 where not exists (select 1 from public.checklist_edges e where e.group_id = o.group_id)
on conflict do nothing;

/*
 * ⚠️ 다음 커밋(일일체크리스트 줄 수 보정)에서 쓸 대상 목록 - **지금은 실행하지 않는다.**
 * 중첩 프로세스가 평평해지면 하위가 없는 잎이 되어, daily = true 인 채로 남으면
 * 일일체크리스트에 「단계 완료」 줄이 새로 늘어난다. 그 후보를 먼저 뽑아 확인한 뒤
 * id 목록으로 끈다 (일괄 update 로 끄면 원래 잎이던 단계까지 함께 꺼진다).
 *
 * select i.id, i.title, i.category,
 *        (select count(*) from public.checklist_items c
 *          where c.parent_id = i.id and c.kind = 'process' and c.deleted_at is null) as sub_cnt
 *   from public.checklist_items i
 *  where i.kind = 'process' and i.daily and i.deleted_at is null
 *    and exists (select 1 from public.checklist_items c
 *                 where c.parent_id = i.id and c.kind = 'process' and c.deleted_at is null)
 *  order by i.category, i.sort_order;
 */

-- ─────────────────── 프로세스 설명 표 (checklist_notes) ───────────────────
-- 프로세스(또는 업무항목·상황) 하나에 붙는 설명 표 - 구분 · 내용 · 비고 세 칸.
-- ⚠️ **이 표만 하드 삭제다** (체크리스트의 soft delete 관례에서 벗어나는 유일한 곳).
-- 체크 기록과 이어지지 않아 되살릴 이유가 없고, 지운 설명 줄을 남겨 두면 표가 지저분해진다.

create table if not exists public.checklist_notes (
    id              text        primary key,
    item_id         text        not null
                                references public.checklist_items (id) on delete cascade,
    label           text        not null default '',          -- 구분
    content         text        not null default '',          -- 내용
    remark          text        not null default '',          -- 비고
    sort_order      integer     not null default 0,
    created_by      uuid        references public.profiles (id),
    created_by_name text        not null default '',
    created_at      timestamptz not null default now(),
    updated_at      timestamptz
);

comment on table public.checklist_notes is '프로세스별 설명 표(구분·내용·비고). 하드 삭제. 편집은 manageChecklist 권한';

create index if not exists checklist_notes_item_idx on public.checklist_notes (item_id, sort_order);

-- ═══════════════════════════════ RLS 정책 ═══════════════════════════════
-- 화면에서도 권한을 판정하지만, 서버에서 한 번 더 막는다.
-- anon 키는 정적 파일에 그대로 담겨 공개되므로 이 정책이 유일한 방어선이다.

alter table public.profiles         enable row level security;
alter table public.orders           enable row level security;
alter table public.order_history    enable row level security;
alter table public.pallets          enable row level security;
alter table public.restore_requests enable row level security;
alter table public.issues           enable row level security;
alter table public.issue_comments   enable row level security;
alter table public.notices          enable row level security;
alter table public.notice_comments  enable row level security;
alter table public.checklist_items  enable row level security;
alter table public.checklist_checks enable row level security;
alter table public.checklist_edges  enable row level security;
alter table public.checklist_notes  enable row level security;

-- ── 사용자 ──
drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles for select to authenticated
    using (true);          -- 로그인 사용자는 담당자 이름을 볼 수 있어야 한다

drop policy if exists profiles_update on public.profiles;
create policy profiles_update on public.profiles for update to authenticated
    using (public.my_role() = 'admin') with check (public.my_role() = 'admin');

-- ⚠️ 관리자만 프로필을 만들 수 있다.
-- `or id = auth.uid()` 를 넣으면 스스로 가입한 사람이 자기 프로필을
-- role='admin' 으로 등록하는 권한 상승이 가능하다. 절대 되살리지 않는다.
drop policy if exists profiles_insert on public.profiles;
create policy profiles_insert on public.profiles for insert to authenticated
    with check (public.my_role() = 'admin');

-- ── 주문 ──
drop policy if exists orders_select on public.orders;
create policy orders_select on public.orders for select to authenticated
    using (public.can_view_all() or created_by = auth.uid());

drop policy if exists orders_insert on public.orders;
create policy orders_insert on public.orders for insert to authenticated
    with check (public.can_write_order() and created_by = auth.uid());

drop policy if exists orders_update on public.orders;
create policy orders_update on public.orders for update to authenticated
    using (
        public.can_update_status()
        or (public.can_write_order() and (public.can_view_all() or created_by = auth.uid()))
        or public.can_confirm_order()
    )
    with check (true);

drop policy if exists orders_delete on public.orders;
create policy orders_delete on public.orders for delete to authenticated
    using (public.my_role() = 'admin'
           or (public.can_write_order() and created_by = auth.uid()));

-- ── 변동사항 이력 ──
-- 등록·수정·단계 처리 어디서나 쌓이므로 주문을 볼 수 있으면 읽고 쓸 수 있다.
drop policy if exists history_select on public.order_history;
create policy history_select on public.order_history for select to authenticated
    using (exists (select 1 from public.orders o where o.id = order_id));

drop policy if exists history_insert on public.order_history;
create policy history_insert on public.order_history for insert to authenticated
    with check (public.my_role() is not null);

drop policy if exists history_update on public.order_history;
create policy history_update on public.order_history for update to authenticated
    using (public.can_confirm_order() or public.can_update_status())
    with check (true);

-- ── 파렛트 ──
-- 주문 등록 시 함께 만들어지므로 등록 권한자도 쓸 수 있어야 한다.
drop policy if exists pallets_select on public.pallets;
create policy pallets_select on public.pallets for select to authenticated
    using (exists (select 1 from public.orders o where o.id = order_id));

drop policy if exists pallets_write on public.pallets;
create policy pallets_write on public.pallets for insert to authenticated
    with check (public.can_update_status() or public.can_write_order());

drop policy if exists pallets_update on public.pallets;
create policy pallets_update on public.pallets for update to authenticated
    using (public.can_update_status() or public.can_write_order()) with check (true);

drop policy if exists pallets_delete on public.pallets;
create policy pallets_delete on public.pallets for delete to authenticated
    using (public.can_update_status() or public.can_write_order());

-- ── 조정요청 ──
drop policy if exists restore_select on public.restore_requests;
create policy restore_select on public.restore_requests for select to authenticated
    using (exists (select 1 from public.orders o where o.id = order_id));

drop policy if exists restore_insert on public.restore_requests;
create policy restore_insert on public.restore_requests for insert to authenticated
    with check (public.can_write_order() and created_by = auth.uid());

drop policy if exists restore_update on public.restore_requests;
create policy restore_update on public.restore_requests for update to authenticated
    using (public.can_confirm_order()) with check (true);

-- ── 이슈 ──
drop policy if exists issues_select on public.issues;
create policy issues_select on public.issues for select to authenticated
    using (public.can_view_all() or created_by = auth.uid());

drop policy if exists issues_insert on public.issues;
create policy issues_insert on public.issues for insert to authenticated
    with check (public.can_create_issue() and created_by = auth.uid());

-- 화주관리자(shipper_admin)는 종결요청된 이슈를 종결승인해야 하므로 수정 권한에 포함한다
drop policy if exists issues_update on public.issues;
create policy issues_update on public.issues for update to authenticated
    using (public.my_role() in ('admin', 'yongma', 'shipper_admin') or created_by = auth.uid())
    with check (true);

-- ── 이슈 댓글 ── 이슈를 볼 수 있는 사람이 읽고 쓴다. 수정·삭제는 작성자 본인만
drop policy if exists issue_comments_select on public.issue_comments;
create policy issue_comments_select on public.issue_comments for select to authenticated
    using (exists (
        select 1 from public.issues i
        where i.id = issue_id and (public.can_view_all() or i.created_by = auth.uid())
    ));

drop policy if exists issue_comments_insert on public.issue_comments;
create policy issue_comments_insert on public.issue_comments for insert to authenticated
    with check (created_by = auth.uid() and exists (
        select 1 from public.issues i
        where i.id = issue_id and (public.can_view_all() or i.created_by = auth.uid())
    ));

drop policy if exists issue_comments_update on public.issue_comments;
create policy issue_comments_update on public.issue_comments for update to authenticated
    using (created_by = auth.uid())
    with check (created_by = auth.uid());

drop policy if exists issue_comments_delete on public.issue_comments;
create policy issue_comments_delete on public.issue_comments for delete to authenticated
    using (created_by = auth.uid());

-- ── 공지사항 ── 조회는 로그인 사용자 모두, 작성은 관리자·용마담당자만
drop policy if exists notices_select on public.notices;
create policy notices_select on public.notices for select to authenticated
    using (true);

drop policy if exists notices_insert on public.notices;
create policy notices_insert on public.notices for insert to authenticated
    with check (public.can_manage_notice() and created_by = auth.uid());

drop policy if exists notices_update on public.notices;
create policy notices_update on public.notices for update to authenticated
    using (public.can_manage_notice())
    with check (public.can_manage_notice());

-- 삭제는 화면이 deleted_at 을 찍는 soft delete 로 하지만, 정리용 실삭제도 같은 권한으로 연다
drop policy if exists notices_delete on public.notices;
create policy notices_delete on public.notices for delete to authenticated
    using (public.can_manage_notice());

-- ── 공지 댓글 ── 로그인 사용자 누구나 읽고 쓴다. 수정·삭제는 본인 또는 관리자
drop policy if exists notice_comments_select on public.notice_comments;
create policy notice_comments_select on public.notice_comments for select to authenticated
    using (true);

drop policy if exists notice_comments_insert on public.notice_comments;
create policy notice_comments_insert on public.notice_comments for insert to authenticated
    with check (created_by = auth.uid());

drop policy if exists notice_comments_update on public.notice_comments;
create policy notice_comments_update on public.notice_comments for update to authenticated
    using (created_by = auth.uid() or public.my_role() = 'admin')
    with check (created_by = auth.uid() or public.my_role() = 'admin');

drop policy if exists notice_comments_delete on public.notice_comments;
create policy notice_comments_delete on public.notice_comments for delete to authenticated
    using (created_by = auth.uid() or public.my_role() = 'admin');

-- ── 업무체크리스트 항목 ── 조회는 로그인 사용자 모두, 편집은 manageChecklist 권한자만
drop policy if exists checklist_items_select on public.checklist_items;
create policy checklist_items_select on public.checklist_items for select to authenticated
    using (true);

drop policy if exists checklist_items_insert on public.checklist_items;
create policy checklist_items_insert on public.checklist_items for insert to authenticated
    with check (public.can_manage_checklist() and created_by = auth.uid());

drop policy if exists checklist_items_update on public.checklist_items;
create policy checklist_items_update on public.checklist_items for update to authenticated
    using (public.can_manage_checklist())
    with check (public.can_manage_checklist());

-- 삭제는 화면이 deleted_at 을 찍는 soft delete 로 하지만, 정리용 실삭제도 같은 권한으로 연다
drop policy if exists checklist_items_delete on public.checklist_items;
create policy checklist_items_delete on public.checklist_items for delete to authenticated
    using (public.can_manage_checklist());

-- ── 업무체크리스트 체크 ── 담당자 본인이 찍거나, 관리 권한자가 대신 찍는다
drop policy if exists checklist_checks_select on public.checklist_checks;
create policy checklist_checks_select on public.checklist_checks for select to authenticated
    using (true);

-- 🔑 checked_by is null 을 함께 허용한다 - 체크는 안 하고 메모만 남긴 행(db.js setCheckMemo)이
--    checked_by 를 비워 넣는다. 이걸 막으면 운영에서 메모 저장이 RLS 로 거부된다.
drop policy if exists checklist_checks_insert on public.checklist_checks;
create policy checklist_checks_insert on public.checklist_checks for insert to authenticated
    with check ((checked_by = auth.uid() or checked_by is null)
                and public.checklist_can_check(item_id));

-- 메모 수정과 **체크 해제**가 지나간다. 체크 해제는 메모가 남은 행의 checked_by 를 null 로 바꾸므로
-- with check 에서도 checked_by is null 을 허용해야 한다 (권한은 checklist_can_check 가 본다).
drop policy if exists checklist_checks_update on public.checklist_checks;
create policy checklist_checks_update on public.checklist_checks for update to authenticated
    using (public.can_manage_checklist() or checked_by = auth.uid()
           or (checked_by is null and public.checklist_can_check(item_id)))
    with check (public.can_manage_checklist() or checked_by = auth.uid()
                or (checked_by is null and public.checklist_can_check(item_id)));

drop policy if exists checklist_checks_delete on public.checklist_checks;
create policy checklist_checks_delete on public.checklist_checks for delete to authenticated
    using (checked_by = auth.uid() or public.checklist_can_check(item_id));

-- ── 업무 흐름 간선 ── 조회는 로그인 사용자 모두(앱·인쇄가 흐름을 읽는다), 편집은 manageChecklist
-- 🔑 판정 함수를 새로 만들지 않는다 - 항목 편집 권한과 같은 권한이어야 한다
drop policy if exists checklist_edges_select on public.checklist_edges;
create policy checklist_edges_select on public.checklist_edges for select to authenticated
    using (true);

drop policy if exists checklist_edges_insert on public.checklist_edges;
create policy checklist_edges_insert on public.checklist_edges for insert to authenticated
    with check (public.can_manage_checklist() and created_by = auth.uid());

drop policy if exists checklist_edges_update on public.checklist_edges;
create policy checklist_edges_update on public.checklist_edges for update to authenticated
    using (public.can_manage_checklist())
    with check (public.can_manage_checklist());

-- 간선은 soft delete 가 아니다 - 흐름에서 빠진 선을 남겨 두면 층 계산이 틀린다
drop policy if exists checklist_edges_delete on public.checklist_edges;
create policy checklist_edges_delete on public.checklist_edges for delete to authenticated
    using (public.can_manage_checklist());

-- ── 프로세스 설명 표 ── 간선과 같은 권한
drop policy if exists checklist_notes_select on public.checklist_notes;
create policy checklist_notes_select on public.checklist_notes for select to authenticated
    using (true);

drop policy if exists checklist_notes_insert on public.checklist_notes;
create policy checklist_notes_insert on public.checklist_notes for insert to authenticated
    with check (public.can_manage_checklist() and created_by = auth.uid());

drop policy if exists checklist_notes_update on public.checklist_notes;
create policy checklist_notes_update on public.checklist_notes for update to authenticated
    using (public.can_manage_checklist())
    with check (public.can_manage_checklist());

drop policy if exists checklist_notes_delete on public.checklist_notes;
create policy checklist_notes_delete on public.checklist_notes for delete to authenticated
    using (public.can_manage_checklist());

-- ═══════════════════════════ 감사 이력 · 단계 권한 강화 ═══════════════════════════
-- (보안 점검 반영: 이력 위변조 차단 · 화주의 단계/완료처리 차단)

-- 이력 기록 본문은 수정 불가 (확인 필드만 허용), 삭제 불가
create or replace function public.lock_history_content()
    returns trigger language plpgsql as $$
begin
    if new.order_id is distinct from old.order_id
        or new.rev is distinct from old.rev
        or new.field is distinct from old.field
        or new.before is distinct from old.before
        or new.after is distinct from old.after
        or new.memo is distinct from old.memo
        or new.changed_by is distinct from old.changed_by
        or new.changed_at is distinct from old.changed_at then
        raise exception '이력 기록 본문은 수정할 수 없습니다 (확인 처리만 가능).';
    end if;
    return new;
end;
$$;

drop trigger if exists trg_lock_history_content on public.order_history;
create trigger trg_lock_history_content
    before update on public.order_history
    for each row execute function public.lock_history_content();

revoke delete on public.order_history from authenticated;

-- 단계·상차·검수·마감 컬럼이 하나도 안 바뀌었는지 (= 순수 내용 수정인지)
create or replace function public.only_content_changed(o public.orders, n public.orders)
    returns boolean language sql immutable as $$
    select o.confirmed_at is not distinct from n.confirmed_at
       and o.ship_started_at is not distinct from n.ship_started_at
       and o.ship_done_at is not distinct from n.ship_done_at
       and o.req_work_at is not distinct from n.req_work_at
       and o.packing_at is not distinct from n.packing_at
       and o.inspect_done_at is not distinct from n.inspect_done_at
       and o.stow_done_at is not distinct from n.stow_done_at
       and o.extra_done_at is not distinct from n.extra_done_at
       and o.loaded_at is not distinct from n.loaded_at
       and o.closed_at is not distinct from n.closed_at
       and o.load_status is not distinct from n.load_status
       and o.inspected is not distinct from n.inspected
$$;

-- 주문 UPDATE 시 무엇을 바꾸려는지 보고 권한을 강제한다.
-- 단계·상차·검수 → updateStatus, 완료처리(closed_at) → closeOrder.
-- null 은 '권한 없음' 으로 처리(coalesce)해 미로그인 우회를 막는다.
create or replace function public.enforce_order_permissions()
    returns trigger language plpgsql security definer set search_path = public as $$
begin
    if new.closed_at is distinct from old.closed_at
        and not coalesce(public.can_close_order(), false) then
        raise exception '출고 완료처리 권한이 없습니다.';
    end if;
    if not public.only_content_changed(old, new)
        and not coalesce(public.can_update_status(), false) then
        raise exception '출고·검수·적치·상차 처리 권한이 없습니다.';
    end if;
    return new;
end;
$$;

drop trigger if exists trg_enforce_order_permissions on public.orders;
create trigger trg_enforce_order_permissions
    before update on public.orders
    for each row execute function public.enforce_order_permissions();

-- ═══════════════════════════ 실시간(Realtime) ═══════════════════════════
-- db.subscribe() 가 이 채널을 구독한다. 폴링 대신 변경 즉시 화면이 갱신된다.

alter publication supabase_realtime add table public.orders;
alter publication supabase_realtime add table public.pallets;
alter publication supabase_realtime add table public.order_history;
alter publication supabase_realtime add table public.restore_requests;
alter publication supabase_realtime add table public.issues;
alter publication supabase_realtime add table public.issue_comments;
alter publication supabase_realtime add table public.notices;
alter publication supabase_realtime add table public.notice_comments;
alter publication supabase_realtime add table public.profiles;
alter publication supabase_realtime add table public.checklist_items;
alter publication supabase_realtime add table public.checklist_checks;
-- 새로 더한 두 표는 기존 구축분에 이미 올라가 있을 수 있어 재실행에 견디게 감싼다
do $$ begin
    alter publication supabase_realtime add table public.checklist_edges;
exception when duplicate_object then null; end $$;
do $$ begin
    alter publication supabase_realtime add table public.checklist_notes;
exception when duplicate_object then null; end $$;

-- ────────────────── 대표주문번호 묶음은 같은 등록자만 (enforce_rep_owner) ──────────────────
-- 화주영업팀은 본인 등록건만 보이므로(RLS) 앱의 assertRepOwner() 만으로는 남의 묶음을
-- 못 본다. SECURITY DEFINER 로 전체 행을 보고 최종 판정한다.
create or replace function public.enforce_rep_owner()
    returns trigger language plpgsql security definer set search_path = public as $$
begin
    if new.rep_no is not null and exists (
        select 1 from public.orders o
         where o.rep_no = new.rep_no and o.id <> new.id and o.created_by <> new.created_by
    ) then
        raise exception '대표주문번호 ''%'' 는 다른 담당자가 등록한 묶음입니다. 같은 담당자가 등록한 주문만 묶을 수 있습니다.',
            new.rep_no;
    end if;
    return new;
end;
$$;

drop trigger if exists trg_enforce_rep_owner on public.orders;
create trigger trg_enforce_rep_owner
    before insert or update of rep_no, created_by on public.orders
    for each row execute function public.enforce_rep_owner();

-- ═══════════════════════════ 유통가공작업 (docs/processing.md) ═══════════════════════════
-- 창고에서 출고 전에 하는 유통가공(라벨 부착·세트 구성·해체)을 등록하고, 구성품(제품 + 부자재)과
-- LOT 을 확정해 작업지시서를 낸다. 주문(orders)과 연결되지 않는 **독립 업무**다.
-- `updated_at` 은 트리거를 쓰지 않고 db.js 가 채운다 (업무 규칙을 서버와 앱 양쪽에 두지 않는다).

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

comment on table public.process_masters is '유통가공 작업마스터(제품별 구성품 BOM). 등록·수정·삭제는 manageProcessing 권한';

create unique index if not exists process_masters_code_uidx
    on public.process_masters (product_code) where deleted_at is null;

-- 마스터 구성품. 마스터를 지우면 함께 사라진다 (작업에는 값이 복사돼 있어 영향이 없다)
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
-- 진행상태는 저장하지 않는다. done_at → 작업완료, pre_check_at → 작업중, 없으면 작업대기.
-- (둘 다 앱 검수에서만 찍힌다 - 문서생성은 상태를 바꾸지 않는다 · docs/processing.md §8)
-- 문서번호는 한 번 나가면 고정이고 재생성하지 않는다 (unique 가 최후 방어선).
-- 삭제는 soft delete 라 지워진 작업의 번호도 되돌아오지 않는다.
create table if not exists public.process_jobs (
    id                  text        primary key,
    doc_no              text        unique,
    -- 마스터를 하드 삭제해도 작업은 남는다 (구성품은 값으로 복사돼 있어 지시서가 그대로 열린다)
    master_id           text        references public.process_masters (id) on delete set null,
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

comment on table public.process_jobs is '유통가공 작업. 진행상태는 저장하지 않고 done_at·pre_check_at 으로 계산한다(db.processStatus)';

create index if not exists process_jobs_date_idx on public.process_jobs (start_date, due_date);
create index if not exists process_jobs_code_idx on public.process_jobs (product_code);

-- 구성품 스냅샷 + LOT 행. line_no 가 같은 행들이 구성품 한 줄이다.
-- 🔑 마스터를 참조하지 않고 **값을 복사**한다 - 마스터가 바뀌어도 이미 인쇄한 작업지시서를
-- 다시 뽑았을 때 내용이 달라지지 않게 한다.
create table if not exists public.process_job_items (
    id         text     primary key,
    job_id     text     not null references public.process_jobs (id) on delete cascade,
    line_no    integer  not null,
    kind       text     not null check (kind in ('제품', '부자재')),
    code       text     not null default '',
    name       text     not null,
    qty_per    integer  not null check (qty_per > 0),    -- 마스터 필요수량 스냅샷
    lot        text     not null default '',             -- 제품 행만 쓴다
    qty        integer  not null check (qty > 0),
    sort_order integer  not null default 0
);

create index if not exists process_job_items_job_idx
    on public.process_job_items (job_id, line_no, sort_order);

-- ── 권한 판정 함수 (config.js 의 manageProcessing 과 같아야 한다) ──
create or replace function public.can_manage_processing()
    returns boolean language sql stable set search_path = public as $$
    select public.my_role() in ('admin', 'yongma', 'shipper_admin')
$$;

-- ── RLS ── 조회는 로그인 사용자 모두 (창고 내부 업무라 등록자 제한을 두지 않는다)
alter table public.process_masters      enable row level security;
alter table public.process_master_items enable row level security;
alter table public.process_jobs         enable row level security;
alter table public.process_job_items    enable row level security;

drop policy if exists process_masters_select on public.process_masters;
create policy process_masters_select on public.process_masters for select to authenticated
    using (true);

drop policy if exists process_masters_insert on public.process_masters;
create policy process_masters_insert on public.process_masters for insert to authenticated
    with check (public.can_manage_processing() and created_by = auth.uid());

drop policy if exists process_masters_update on public.process_masters;
create policy process_masters_update on public.process_masters for update to authenticated
    using (public.can_manage_processing()) with check (public.can_manage_processing());

-- 🔑 앱은 soft delete(deleted_at) 만 쓴다. 하드 삭제는 관리자만 - 실수로 지운 마스터는
-- 되돌릴 길이 없고, 자식 구성품이 cascade 로 함께 사라진다.
drop policy if exists process_masters_delete on public.process_masters;
create policy process_masters_delete on public.process_masters for delete to authenticated
    using (public.my_role() = 'admin');

drop policy if exists process_master_items_select on public.process_master_items;
create policy process_master_items_select on public.process_master_items
    for select to authenticated using (true);

drop policy if exists process_master_items_insert on public.process_master_items;
create policy process_master_items_insert on public.process_master_items
    for insert to authenticated with check (public.can_manage_processing());

drop policy if exists process_master_items_update on public.process_master_items;
create policy process_master_items_update on public.process_master_items
    for update to authenticated
    using (public.can_manage_processing()) with check (public.can_manage_processing());

drop policy if exists process_master_items_delete on public.process_master_items;
create policy process_master_items_delete on public.process_master_items
    for delete to authenticated using (public.can_manage_processing());

drop policy if exists process_jobs_select on public.process_jobs;
create policy process_jobs_select on public.process_jobs for select to authenticated
    using (true);

-- 작업만 등록자를 함께 본다 (마스터와 달리 등록자 이름이 작업지시서에 찍힌다)
drop policy if exists process_jobs_insert on public.process_jobs;
create policy process_jobs_insert on public.process_jobs for insert to authenticated
    with check (public.can_manage_processing() and created_by = auth.uid());

-- ⚠️ 이 정책은 **아래 「모바일 검수」 블록에서 다시 만든다** (검수 권한까지 열고 트리거로 좁힌다).
-- 여기 남겨 두는 것은 모바일 블록을 떼어내도 등록 권한자의 수정이 막히지 않게 하기 위해서다.
drop policy if exists process_jobs_update on public.process_jobs;
create policy process_jobs_update on public.process_jobs for update to authenticated
    using (public.can_manage_processing()) with check (public.can_manage_processing());

-- 하드 삭제는 관리자만 (db.deleteProcessJobs 는 soft delete 다 - 문서번호를 되살리지 않는다)
drop policy if exists process_jobs_delete on public.process_jobs;
create policy process_jobs_delete on public.process_jobs for delete to authenticated
    using (public.my_role() = 'admin');

drop policy if exists process_job_items_select on public.process_job_items;
create policy process_job_items_select on public.process_job_items
    for select to authenticated using (true);

drop policy if exists process_job_items_insert on public.process_job_items;
create policy process_job_items_insert on public.process_job_items
    for insert to authenticated with check (public.can_manage_processing());

drop policy if exists process_job_items_update on public.process_job_items;
create policy process_job_items_update on public.process_job_items
    for update to authenticated
    using (public.can_manage_processing()) with check (public.can_manage_processing());

drop policy if exists process_job_items_delete on public.process_job_items;
create policy process_job_items_delete on public.process_job_items
    for delete to authenticated using (public.can_manage_processing());

-- ── 문서번호는 한 번 나가면 바꾸지 않는다 (재채번·번호 갈아끼우기 차단) ──
-- 화면과 db.issueProcessDoc 이 이미 막지만, 서버에서도 못 박아 둔다.
create or replace function public.enforce_process_doc_no()
    returns trigger language plpgsql set search_path = public as $$
begin
    if old.doc_no is not null and new.doc_no is distinct from old.doc_no then
        raise exception '작업지시서 문서번호 ''%'' 는 변경할 수 없습니다.', old.doc_no;
    end if;
    return new;
end;
$$;

drop trigger if exists trg_enforce_process_doc_no on public.process_jobs;
create trigger trg_enforce_process_doc_no
    before update of doc_no on public.process_jobs
    for each row execute function public.enforce_process_doc_no();

-- ── 실시간 갱신 (멱등) ── db.subscribe() 가 store.js 의 TABLES 를 돌며 자동으로 구독한다.
-- 이미 publication 멤버면 42710 오류가 나므로 가드를 둔다 (재실행 안전).
do $$
declare
    t text;
begin
    if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
        raise notice 'supabase_realtime publication 이 없어 건너뜁니다.';
        return;
    end if;
    if (select puballtables from pg_publication where pubname = 'supabase_realtime') then
        raise notice 'supabase_realtime 이 FOR ALL TABLES 라 추가할 것이 없습니다.';
        return;
    end if;
    foreach t in array array[
        'process_masters', 'process_master_items', 'process_jobs', 'process_job_items'
    ] loop
        if not exists (
            select 1 from pg_publication_tables
            where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
        ) then
            execute format('alter publication supabase_realtime add table public.%I', t);
        end if;
    end loop;
end $$;

-- ─────────── 유통가공 모바일 검수 (docs/processing.md §17) · 멱등 ───────────
-- 현장이 휴대폰으로 남기는 사진 증빙. **상태를 움직이는 유일한 경로**다.
--   작업대기 ─(작업전 검수: 구성품 줄마다 1장)→ 작업중 ─(완료 검수: 3장)→ 작업완료
-- 🔑 문서생성(doc_created_at)은 더 이상 상태를 바꾸지 않는다 (§8 개정).
-- 전부 if not exists / create or replace / drop policy if exists 라 몇 번을 돌려도 같은 결과다.
-- ⚠️ 이 블록은 supabase/migrations 초안(20260919_processing_mobile.sql)과 **글자까지 같아야 한다.**

alter table public.process_jobs add column if not exists pre_check_at      timestamptz;
alter table public.process_jobs add column if not exists pre_check_by      uuid references public.profiles (id);
alter table public.process_jobs add column if not exists pre_check_by_name text not null default '';
alter table public.process_jobs add column if not exists done_by           uuid references public.profiles (id);
alter table public.process_jobs add column if not exists done_by_name      text not null default '';

comment on column public.process_jobs.pre_check_at is '작업전 검수 완료 시각. 있으면 작업중 (db.processStatus)';
comment on column public.process_jobs.done_at is '완료 검수 시각. 있으면 작업완료 (앱에서만 찍힌다)';

-- 사진 **파일은 Storage**(버킷 process-photos), 여기에는 메타만 둔다.
create table if not exists public.process_photos (
    id            text        primary key,
    job_id        text        not null references public.process_jobs (id) on delete cascade,
    phase         text        not null check (phase in ('pre', 'done')),
    line_no       integer,                       -- 작업전: 구성품 줄 · 완료: null
    seq           integer     not null default 1,
    path          text        not null,          -- jobs/{job_id}/{phase}/{line_no|seq}.jpg
    size          integer     not null default 0,
    taken_by      uuid        references public.profiles (id),
    taken_by_name text        not null default '',
    taken_at      timestamptz not null default now()
);

comment on table public.process_photos is '유통가공 검수 사진 메타. 파일은 Storage 버킷 process-photos 에 있다';

-- 🔑 슬롯 규칙을 서버에도 못 박는다 - 작업전은 「구성품 줄마다 1장」(line_no · seq 1),
-- 완료는 「줄과 무관한 3장」(line_no 없음 · seq 1~3). db.js 의 commitPhotos 가 넣는 값과 같다.
-- 없으면 phase 와 슬롯 키가 어긋난 행(작업전인데 line_no 없음)이 들어가 unique 슬롯이 헛돈다.
alter table public.process_photos drop constraint if exists process_photos_slot_chk;
alter table public.process_photos add constraint process_photos_slot_chk check (
    seq > 0 and (
        (phase = 'pre'  and line_no is not null and line_no > 0 and seq = 1)
     or (phase = 'done' and line_no is null)
    )
);

-- 🔑 null 이 섞인 unique 는 중복을 막지 못한다. coalesce 로 한 자리에 모은다.
-- 재촬영·재저장은 **같은 행을 update** 하고 같은 경로를 덮어쓴다 (Storage 에 고아가 안 쌓인다)
create unique index if not exists process_photos_slot_uidx
    on public.process_photos (job_id, phase, coalesce(line_no, -1), seq);

-- (job_id, phase) 인덱스는 위 unique 의 선두 두 컬럼과 겹쳐 쓸모가 없다. 쓰기만 느려진다
drop index if exists public.process_photos_job_idx;

alter table public.process_photos enable row level security;

-- 🔑 검수는 manageProcessing 이 아니라 **updateStatus** 다 (docs/processing.md A14).
-- 현장작업자는 등록 권한이 없지만 사진을 찍는 사람이고, 화주관리자는 그 반대다.
-- 🔑 조회는 **활성 로그인 사용자**로 좁힌다(다른 테이블의 using(true) 와 다르다).
-- 사진은 현장 사람·제품이 찍힌 개인정보라, 중지된 계정의 토큰이 남아 있어도 보이지 않게 한다.
drop policy if exists process_photos_select on public.process_photos;
create policy process_photos_select on public.process_photos for select to authenticated
    using (public.my_role() is not null);

drop policy if exists process_photos_insert on public.process_photos;
create policy process_photos_insert on public.process_photos for insert to authenticated
    with check (public.can_update_status() and taken_by = auth.uid());

-- 🔑 재촬영도 「찍은 사람 = 나」 를 유지한다 (증빙의 명의 바꿔치기 차단)
drop policy if exists process_photos_update on public.process_photos;
create policy process_photos_update on public.process_photos for update to authenticated
    using (public.can_update_status())
    with check (public.can_update_status() and taken_by = auth.uid());

drop policy if exists process_photos_delete on public.process_photos;
create policy process_photos_delete on public.process_photos for delete to authenticated
    using (public.my_role() = 'admin');

-- ── 🔴 검수가 상태를 못 찍던 구멍 (process_jobs_update) ──
-- 위쪽 블록의 process_jobs_update 는 can_manage_processing() 뿐이라, 현장작업자(worker)의
-- pre_check_at·done_at UPDATE 가 **0행으로 조용히 실패**했다(PostgREST 는 오류를 주지 않는다).
-- 정책을 updateStatus 까지 열고, 넓어진 만큼 트리거로 **고칠 수 있는 컬럼을** 좁힌다.
create or replace function public.enforce_process_check_cols()
    returns trigger language plpgsql set search_path = public as $$
declare
    probe public.process_jobs;
begin
    if public.can_manage_processing() then
        return new;                      -- 등록 권한자는 종전대로 전부 수정
    end if;
    if not public.can_update_status() then
        raise exception '유통가공 작업을 수정할 권한이 없습니다.';
    end if;
    -- 검수 컬럼만 old 로 되돌린 사본이 old 와 같아야 한다 = 나머지를 건드리지 않았다
    probe := new;
    probe.pre_check_at      := old.pre_check_at;
    probe.pre_check_by      := old.pre_check_by;
    probe.pre_check_by_name := old.pre_check_by_name;
    probe.done_at           := old.done_at;
    probe.done_by           := old.done_by;
    probe.done_by_name      := old.done_by_name;
    probe.updated_at        := old.updated_at;
    if probe is distinct from old then
        raise exception '검수 권한으로는 검수 항목만 수정할 수 있습니다.';
    end if;
    return new;
end;
$$;

drop trigger if exists trg_enforce_process_check_cols on public.process_jobs;
create trigger trg_enforce_process_check_cols
    before update on public.process_jobs
    for each row execute function public.enforce_process_check_cols();

drop policy if exists process_jobs_update on public.process_jobs;
create policy process_jobs_update on public.process_jobs for update to authenticated
    using      (public.can_manage_processing() or public.can_update_status())
    with check (public.can_manage_processing() or public.can_update_status());

-- ── Storage 버킷 (private · 1MB · JPEG 만) ──
-- ⚠️ file_size_limit 은 압축 목표(200KB)의 5배다. 목표를 못 맞춘 사진(라벨·도장이 많은 화면은
-- JPEG 가 잘 안 줄어든다)도 통과시키되 원본(3~8MB)은 확실히 막는다.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('process-photos', 'process-photos', false, 1048576, array['image/jpeg'])
on conflict (id) do update
    set public = false, file_size_limit = 1048576, allowed_mime_types = array['image/jpeg'];

-- ── storage.objects 정책 (이 버킷 한정) ──
-- ⚠️ storage.objects 는 supabase_storage_admin 소유다. 소유자 오류가 나면
--    Dashboard → Storage → Policies 에서 같은 이름·같은 식으로 만든다.
--    (`alter table storage.objects enable row level security` 는 넣지 않는다 - 소유자 오류가 난다.
--     Supabase 는 이 테이블의 RLS 를 이미 켜 두었다)
-- ⚠️ 읽기가 **버킷 전체**인 것은 버킷이 private 이기 때문이다. 서명 URL 발급도 이 정책을
-- 탄다. 공개 버킷으로 바꾸면 주소만 알면 누구나 보게 되므로 바꾸지 않는다.
-- 🔑 사진 메타(process_photos_select)와 같은 기준으로 **활성 로그인 사용자**만 읽는다.
drop policy if exists process_photos_obj_select on storage.objects;
create policy process_photos_obj_select on storage.objects for select to authenticated
    using (bucket_id = 'process-photos' and public.my_role() is not null);

-- 🔑 쓰기는 **경로까지** 강제한다. 권한만 보면 검수 권한자가 `jobs/…` 밖이나 없는 작업 아래에
-- 아무 파일이나 올려 버킷을 개인 저장소로 쓸 수 있다. 경로 규칙은 db.js 의 photoPath 하나뿐이라
-- (jobs/{job_id}/{phase}/{slot}.jpg) 서버가 같은 모양을 요구해도 정상 경로는 막히지 않는다.
-- storage.foldername(name) 은 파일명을 뺀 폴더 배열이다 - [1]='jobs' · [2]=작업 id (1부터).
drop policy if exists process_photos_obj_insert on storage.objects;
create policy process_photos_obj_insert on storage.objects for insert to authenticated
    with check (
        bucket_id = 'process-photos'
        and public.can_update_status()
        and (storage.foldername(name))[1] = 'jobs'
        and exists (
            select 1 from public.process_jobs j
            where j.id = (storage.foldername(name))[2] and j.deleted_at is null
        )
    );

-- 🔑 update 정책이 꼭 필요하다 - 재촬영이 같은 경로를 덮어쓴다(upsert 는 UPDATE 를 탄다).
-- insert 만 열면 재촬영이 조용히 실패한다.
drop policy if exists process_photos_obj_update on storage.objects;
create policy process_photos_obj_update on storage.objects for update to authenticated
    using (bucket_id = 'process-photos' and public.can_update_status())
    with check (
        bucket_id = 'process-photos'
        and public.can_update_status()
        and (storage.foldername(name))[1] = 'jobs'
        and exists (
            select 1 from public.process_jobs j
            where j.id = (storage.foldername(name))[2] and j.deleted_at is null
        )
    );

drop policy if exists process_photos_obj_delete on storage.objects;
create policy process_photos_obj_delete on storage.objects for delete to authenticated
    using (bucket_id = 'process-photos' and public.my_role() = 'admin');

-- ── 실시간 갱신 (멱등 가드 - alter publication 은 재실행 시 42710 으로 죽는다) ──
do $$
begin
    if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
        raise notice 'supabase_realtime publication 이 없어 건너뜁니다.';
        return;
    end if;
    if (select puballtables from pg_publication where pubname = 'supabase_realtime') then
        raise notice 'supabase_realtime 이 FOR ALL TABLES 라 추가할 것이 없습니다.';
        return;
    end if;
    if not exists (
        select 1 from pg_publication_tables
        where pubname = 'supabase_realtime' and schemaname = 'public'
          and tablename = 'process_photos'
    ) then
        alter publication supabase_realtime add table public.process_photos;
    end if;
end $$;
