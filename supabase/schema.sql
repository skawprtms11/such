-- 더퓨어랩 주문접수시스템 - Supabase 스키마
-- Supabase 프로젝트 생성 후 SQL Editor 에서 실행한다.
-- 실행 후 assets/js/config.js 의 SUPABASE.url / anonKey 를 채우고
-- DATA_SOURCE 를 'supabase' 로 변경한다.

-- ============================ 1. 열거형 정의 ============================

create type user_role as enum ('admin', 'yongma', 'shipper_admin', 'shipper_sales', 'worker');
create type company_kind as enum ('고객사', '용마로지스', '협력사');
create type vehicle_type as enum ('픽업', '용차');
create type load_status as enum ('대기', '검수', '완료');
create type issue_type as enum ('오출고', '재고부족', '작업요청', '기타');
create type extra_work as enum ('라벨작업', '박스교체', 'LOT지정');
-- 항목을 추가할 때는 config.js 의 EXTRA_WORKS 와 함께 맞춘다.
-- 운영 중이라면: alter type extra_work add value '새항목';
create type restore_type as enum ('email', 'form');
create type issue_status as enum ('접수', '확인중', '종결');

-- ============================ 2. 사용자 프로필 ============================
-- auth.users 와 1:1 로 연결되는 프로필 테이블

create table public.profiles (
    id          uuid primary key references auth.users (id) on delete cascade,
    name        text        not null,
    email       text        not null,
    company     company_kind not null default '고객사',
    phone       text,
    role        user_role   not null default 'shipper_sales',
    active      boolean     not null default true,
    created_at  timestamptz not null default now()
);

-- 권한 판정 헬퍼 (RLS 정책에서 재귀 참조를 피하기 위해 security definer 로 만든다)
create or replace function public.current_role()
returns user_role
language sql
security definer
stable
set search_path = public
as $$
    select role from public.profiles where id = auth.uid();
$$;

-- 주문정보등록 화면의 작성 권한 (등록·수정·조정요청)
-- 관리자·화주관리자는 항상, 그 외 역할은 소속이 고객사일 때만 허용한다.
create or replace function public.can_write_order()
returns boolean
language sql
security definer
stable
set search_path = public
as $$
    select coalesce((
        select role in ('admin', 'shipper_admin') or company = '고객사'
          from public.profiles where id = auth.uid()
    ), false);
$$;

-- 주문정보등록 화면의 확인 권한 (접수/수정/조정 체크, 이력 확인처리)
-- 관리자·화주관리자는 항상, 그 외 역할은 소속이 용마로지스일 때만 허용한다.
create or replace function public.can_confirm_order()
returns boolean
language sql
security definer
stable
set search_path = public
as $$
    select coalesce((
        select role in ('admin', 'shipper_admin') or company = '용마로지스'
          from public.profiles where id = auth.uid()
    ), false);
$$;

create or replace function public.can_view_all()
returns boolean
language sql
security definer
stable
set search_path = public
as $$
    select coalesce(
        (select role in ('admin', 'yongma', 'shipper_admin') from public.profiles
         where id = auth.uid()),
        false);
$$;

-- ============================== 3. 주문 ==============================

create table public.orders (
    id             uuid primary key default gen_random_uuid(),
    reg_date       date         not null default current_date,   -- 등록일자
    send_date      date         not null,                        -- 전송일자
    seq            int          not null default 1,              -- 차수
    order_no       text         not null,                        -- 주문번호
    customer       text         not null,                        -- 거래처명
    ship_req_date  date         not null,                        -- 출고요청일
    vehicle_type   vehicle_type not null,                        -- 차량구분
    extra_works    extra_work[] not null default '{}',            -- 추가작업 (복수 선택)
    request_note   text         default '',                      -- 요청사항
    remark         text         default '',                      -- 비고
    item_count     int          not null default 0,              -- 품목수
    qty            int          not null default 0,              -- 출고수량
    pallet_count   int          not null default 0,              -- 파렛트수 (검수완료 시 실측 입력)
    box_count      int          not null default 0,              -- 박스수 (검수완료 시 실측 입력)
    edit_count     int          not null default 0,              -- 수정 횟수
    -- 접수확인 (확인 컬럼의 '접수' 체크박스). null 이면 미확인
    -- '수정'/'조정' 체크는 별도 컬럼이 없다. order_history / restore_requests 의
    -- checked_at 을 집계해 판정하므로 새 변경이 생기면 자동으로 풀린다.
    confirmed_at   timestamptz,
    confirmed_by   uuid         references public.profiles (id),
    -- 상차까지 끝난 뒤 용마담당자가 찍는 최종 완료처리.
    -- 값이 있으면 주문처리현황의 '현재진행' 에서 빠지고 '출고완료' 탭으로 간다
    stow_done_at   timestamptz,                                    -- 출고적치 완료
    closed_at      timestamptz,
    closed_by      uuid         references public.profiles (id),
    -- 취소 처리. 취소되면 수정·조정요청이 막히고 진행상태가 '취소' 가 된다
    canceled_at    timestamptz,
    canceled_by    uuid         references public.profiles (id),
    stage          int          not null default 0,              -- 처리 단계 (0~5)
    inspected      int          not null default 0,              -- 검수 완료 파렛트 수
    status         load_status  not null default '대기',
    created_by     uuid         not null references public.profiles (id),
    created_at     timestamptz  not null default now(),
    updated_at     timestamptz  not null default now(),
    constraint orders_stage_range check (stage between 0 and 5)
);

-- 진행상태는 컬럼으로 두지 않고 주문 상태에서 계산한다.
-- 취소 > 완료(stage 5) > 진행(접수됨) > 대기 순으로 우선한다.
create or replace function public.order_progress(o public.orders)
returns text
language sql
immutable
as $$
    select case
        when o.canceled_at is not null then '취소'
        when o.stage >= 5 then '완료'
        when o.confirmed_at is not null then '진행'
        else '대기'
    end;
$$;

create index orders_ship_req_date_idx on public.orders (ship_req_date);
create index orders_reg_date_idx      on public.orders (reg_date);
create index orders_created_by_idx    on public.orders (created_by);
create unique index orders_no_seq_idx on public.orders (order_no, seq);

-- 동일 주문번호가 이미 있으면 차수를 자동으로 증가시킨다
-- 차수는 등록 화면에서 '추가주문' 을 골랐을 때만 올라간다.
-- 같은 주문번호라고 자동으로 올리면 신규주문이 2차수로 들어가므로 트리거를 두지 않는다.
-- (예전의 trg_set_order_seq 는 제거했다. 이미 적용한 DB 라면 아래로 지운다)
--   drop trigger if exists trg_set_order_seq on public.orders;
--   drop function if exists public.set_order_seq();

-- ========================= 4. 변동사항 히스토리 =========================

create table public.order_history (
    id          uuid primary key default gen_random_uuid(),
    order_id    uuid        not null references public.orders (id) on delete cascade,
    rev         int         not null default 0, -- 몇 번째 수정인지 (0 이면 등록·삭제 등)
    field       text        not null,   -- 변경 항목명
    before_val  text,
    after_val   text,
    memo        text        default '', -- 변경 사유
    changed_by  uuid        references public.profiles (id),
    changed_at  timestamptz not null default now(),
    checked_at  timestamptz,                -- 수정확인 일시 (null 이면 미확인)
    checked_by  uuid        references public.profiles (id)  -- 확인처리한 사용자
);

create index order_history_unchecked_idx on public.order_history (order_id)
    where rev > 0 and checked_at is null;

create index order_history_order_idx on public.order_history (order_id, changed_at desc);

-- 주문 변경 시 주요 항목의 변동을 자동 기록한다
create or replace function public.log_order_change()
returns trigger
language plpgsql
as $$
declare
    cols text[] := array['send_date', 'order_no', 'customer', 'ship_req_date',
                         'vehicle_type', 'extra_works', 'request_note', 'remark',
                         'item_count', 'qty', 'pallet_count', 'box_count',
                         'stage', 'status'];
    c    text;
    b    text;
    a    text;
begin
    -- 사용자가 고치는 항목이 하나라도 바뀌면 수정 횟수를 1회만 올린다
    if exists (
        select 1 from unnest(cols) col
         where col not in ('stage', 'status', 'confirmed_at', 'canceled_at')
           and to_jsonb(old) ->> col is distinct from to_jsonb(new) ->> col
    ) then
        new.edit_count := old.edit_count + 1;
    end if;

    foreach c in array cols loop
        execute format('select ($1).%I::text, ($2).%I::text', c, c)
           into b, a using old, new;
        if b is distinct from a then
            insert into public.order_history
                (order_id, rev, field, before_val, after_val, changed_by)
            values (new.id,
                    case when c in ('stage', 'status') then 0 else new.edit_count end,
                    c, b, a, auth.uid());
        end if;
    end loop;
    new.updated_at := now();
    return new;
end;
$$;

create trigger trg_log_order_change
    before update on public.orders
    for each row execute function public.log_order_change();

-- ============================ 5. 검수 파렛트 ============================

create table public.pallets (
    id          uuid primary key default gen_random_uuid(),
    order_id    uuid        not null references public.orders (id) on delete cascade,
    barcode     text        not null,
    scanned_at  timestamptz,
    scanned_by  uuid        references public.profiles (id),
    -- 출고적치 로케이션. 파렛트 전량에 값이 차면 orders.stow_done_at 이 채워진다
    location    text        not null default '',
    located_at  timestamptz,
    located_by  uuid        references public.profiles (id),
    -- 상차 준비로 적치 위치에서 내린 시각 (당일상차리스트의 로케이션 팝업에서 체크)
    picked_at   timestamptz,
    picked_by   uuid        references public.profiles (id),
    unique (order_id, barcode)
);

create index pallets_order_idx on public.pallets (order_id);

-- 파렛트 스캔 시 주문의 검수 수량과 상태를 갱신한다
create or replace function public.sync_inspection()
returns trigger
language plpgsql
as $$
declare
    done  int;
    total int;
begin
    select count(*) filter (where scanned_at is not null), count(*)
      into done, total
      from public.pallets
     where order_id = new.order_id;

    update public.orders
       set inspected = done,
           status = case
               when total > 0 and done >= total and status = '대기' then '검수'::load_status
               when done < total and status = '검수' then '대기'::load_status
               else status
           end
     where id = new.order_id;
    return new;
end;
$$;

create trigger trg_sync_inspection
    after update of scanned_at on public.pallets
    for each row execute function public.sync_inspection();

-- ============================= 6. 조정요청 =============================
-- 등록된 주문의 조정(되돌림)을 요청한다.
--   type='email' : 사유만 선택. 담당자에게 메일로 발송 (별도 작성 내용 없음)
--   type='form'  : 제품코드·수량·사유를 직접 작성

create table public.restore_requests (
    id            uuid         primary key default gen_random_uuid(),
    order_id      uuid         not null references public.orders (id) on delete cascade,
    type          restore_type not null,
    reason        text         not null,   -- email 이면 선택한 사유, form 이면 작성한 사유
    order_no      text         not null,
    customer      text         not null,
    product_code  text         default '', -- form 타입에서만 사용
    qty           int,                     -- form 타입에서만 사용
    created_by    uuid         not null references public.profiles (id),
    created_at    timestamptz  not null default now(),
    checked_at    timestamptz,             -- 조정확인 일시 (null 이면 미확인)
    checked_by    uuid         references public.profiles (id),
    -- 직접 작성 방식은 제품코드와 수량이 반드시 있어야 한다
    constraint restore_form_fields check (
        type <> 'form' or (coalesce(product_code, '') <> '' and qty is not null)
    )
);

-- 조정요청은 취소되지 않고 패킹리스트 완료(stage 4) 이전인 주문만 등록할 수 있다
create or replace function public.check_restore_stage()
returns trigger
language plpgsql
as $$
declare
    o public.orders;
begin
    select * into o from public.orders where id = new.order_id;
    if o.canceled_at is not null then
        raise exception '취소된 주문에는 조정요청을 등록할 수 없습니다.';
    end if;
    if o.stage >= 4 then
        raise exception '패킹리스트 완료 이후에는 조정요청을 등록할 수 없습니다.';
    end if;
    return new;
end;
$$;

create trigger trg_check_restore_stage
    before insert on public.restore_requests
    for each row execute function public.check_restore_stage();

create index restore_requests_order_idx on public.restore_requests (order_id, created_at desc);

-- ============================== 7. 이슈 ==============================

create table public.issues (
    id          uuid primary key default gen_random_uuid(),
    type        issue_type   not null,
    title       text         not null,
    content     text         not null,
    order_no    text,
    due_date    date         not null,          -- 확인요청일
    status      issue_status not null default '접수',
    created_by  uuid         not null references public.profiles (id),
    created_at  timestamptz  not null default now()
);

create index issues_created_idx on public.issues (created_at desc);

-- ============================ 8. RLS 정책 ============================

alter table public.profiles      enable row level security;
alter table public.orders        enable row level security;
alter table public.order_history enable row level security;
alter table public.pallets       enable row level security;
alter table public.issues        enable row level security;
alter table public.restore_requests enable row level security;

-- 프로필: 본인은 항상 조회, 관리자/전체조회 권한자는 전체 조회, 권한 변경은 관리자만
create policy profiles_select on public.profiles for select
    using (id = auth.uid() or public.can_view_all());

create policy profiles_update on public.profiles for update
    using (public.current_role() = 'admin');

create policy profiles_insert on public.profiles for insert
    with check (public.current_role() = 'admin' or id = auth.uid());

-- 주문: 화주영업팀은 본인 등록건만, 그 외 권한은 전체 조회
create policy orders_select on public.orders for select
    using (public.can_view_all() or created_by = auth.uid());

create policy orders_insert on public.orders for insert
    with check (public.can_write_order() and created_by = auth.uid());

-- 주문 수정은 상차완료(stage 5) 이전까지만 가능하다.
-- 용마담당자는 처리현황 갱신·접수확인을 위해 상차완료 건도 다룰 수 있어야 하므로 별도로 허용한다.
create policy orders_update on public.orders for update
    using (
        public.can_confirm_order()
        or (public.can_write_order() and stage < 5
            and (public.can_view_all() or created_by = auth.uid()))
    );

create policy orders_delete on public.orders for delete
    using (public.current_role() = 'admin'
           or (public.can_write_order() and created_by = auth.uid() and stage = 0));

-- 히스토리: 주문 조회 권한과 동일, 수정 불가
create policy history_select on public.order_history for select
    using (exists (select 1 from public.orders o where o.id = order_id));

-- 이력의 수정확인은 확인 권한이 있는 사용자만 토글할 수 있다 (내용 자체는 수정 불가)
create policy history_check on public.order_history for update
    using (public.can_confirm_order());

-- 파렛트: 조회는 주문과 동일, 스캔 업데이트는 용마담당자/관리자만
create policy pallets_select on public.pallets for select
    using (exists (select 1 from public.orders o where o.id = order_id));

create policy pallets_update on public.pallets for update
    using (public.current_role() in ('admin', 'yongma'));

create policy pallets_insert on public.pallets for insert
    with check (public.current_role() in ('admin', 'yongma', 'shipper_admin', 'shipper_sales'));

-- 조정요청: 주문 조회 권한과 동일. 등록은 주문을 등록할 수 있는 역할만
create policy restore_select on public.restore_requests for select
    using (exists (select 1 from public.orders o where o.id = order_id));

create policy restore_insert on public.restore_requests for insert
    with check (public.can_write_order() and created_by = auth.uid());

-- 조정확인은 확인 권한이 있는 사용자만 토글할 수 있다
create policy restore_check on public.restore_requests for update
    using (public.can_confirm_order());

-- 이슈: 화주영업팀은 본인 등록건만 조회, 상태 변경은 용마담당자/관리자
create policy issues_select on public.issues for select
    using (public.can_view_all() or created_by = auth.uid());

create policy issues_insert on public.issues for insert
    with check (created_by = auth.uid());

create policy issues_update on public.issues for update
    using (public.current_role() in ('admin', 'yongma') or created_by = auth.uid());

-- ========================== 9. 실시간(Realtime) ==========================

alter publication supabase_realtime add table public.orders;
alter publication supabase_realtime add table public.pallets;
alter publication supabase_realtime add table public.issues;
alter publication supabase_realtime add table public.restore_requests;
