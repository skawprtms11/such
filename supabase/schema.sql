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
    customer          text        not null,                        -- 거래처명
    ship_req_date     date        not null,                        -- 출고요청일
    vehicle_type      text        not null default '픽업',          -- 픽업 | 용차
    extra_works       text[]      not null default '{}',           -- 추가작업 (다중 선택)
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
    id         text        primary key,
    type       text        not null,                               -- 오출고|재고부족|작업요청|기타
    title      text        not null,
    order_no   text        not null default '',
    content    text        not null default '',
    due_date   date,
    status     text        not null default '접수',                 -- 접수|확인중|종결
    created_by uuid        references public.profiles (id),
    created_at timestamptz not null default now()
);

create index if not exists issues_order_no_idx on public.issues (order_no);

-- ═══════════════════════════════ RLS 정책 ═══════════════════════════════
-- 화면에서도 권한을 판정하지만, 서버에서 한 번 더 막는다.
-- anon 키는 정적 파일에 그대로 담겨 공개되므로 이 정책이 유일한 방어선이다.

alter table public.profiles         enable row level security;
alter table public.orders           enable row level security;
alter table public.order_history    enable row level security;
alter table public.pallets          enable row level security;
alter table public.restore_requests enable row level security;
alter table public.issues           enable row level security;

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

drop policy if exists issues_update on public.issues;
create policy issues_update on public.issues for update to authenticated
    using (public.my_role() in ('admin', 'yongma') or created_by = auth.uid())
    with check (true);

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
alter publication supabase_realtime add table public.profiles;
