/**
 * 유통가공 검수 (모바일 앱).
 *
 *   #/pcheck             세그 [ 작업전 검수 | 완료 검수 | 캘린더 ]
 *   #/pcheck/pre/:id     구성품 줄마다 사진 1장 → [저장] → [검수완료]  → 작업중
 *   #/pcheck/done/:id    완료 사진 3장          → [저장] → [완료처리]  → 작업완료
 *
 * 🔑 **업무 규칙은 db.js 에 있다** (docs/processing.md §17). 화면은 상태를 다시 계산하지 않고
 * 목록이 붙여 준 `status` 만 그리며, 「사진이 다 찼을 때만 검수완료」 도 db 가 같이 막는다.
 * 🔑 등록·문서생성은 웹 화면(`#/processing`)이다. 앱에는 검수만 있다.
 *
 * 촬영분은 **저장 전까지 IndexedDB 초안**으로 남는다 - 화면을 떠났다 돌아와도 복구된다.
 */
import {
    PROCESS_DONE_PHOTOS, PROCESS_PHASE, PROCESS_PHASES,
    PROCESS_PHASE_LABEL, PROCESS_STATUS_TONE, WEEKDAYS,
} from '../../config.js';
import * as db from '../../db.js';
import { icon } from '../../icons.js';
import { STORE, idbDel, idbList, idbPut } from '../../idb.js';
import { compressPhoto } from '../../photo.js';
import { calendarLanes } from '../../processing-calc.js';
import {
    confirmDialog, esc, fmtDateTime, num, toast, today,
} from '../../util.js';
import {
    actionDock, bindPhotoSlots, card, closeAllSheets, dock, emptyState, menuSheet,
    photoSlot, pollGuard, scanBar, segment, sheet, tag,
} from '../ui.js';

/** 세그·검색어·달 - 상세를 다녀와도 유지한다 */
const state = {
    seg: PROCESS_PHASE.PRE,
    keyword: '',
    month: today().slice(0, 7),
};

/** 캘린더 세그 키 (검수 단계가 아니라 조회 화면이다) */
const SEG_CAL = 'cal';

/** 앱은 폭이 좁아 레인을 2개만 그린다 (웹은 3개) */
const APP_MAX_LANE = 2;

export async function render(root, { user, params }) {
    const [phase, jobId] = params;
    if (jobId && PROCESS_PHASES.includes(phase)) {
        return renderDetail(root, user, phase, jobId);
    }
    return renderList(root, user);
}

/* ================================== 목록 ================================== */

async function renderList(root, user) {
    root.innerHTML = '<div id="seghost"></div><div id="pane"></div>';
    const paneEl = root.querySelector('#pane');
    let paneClean = null;
    // 세그를 연타하면 앞 `openPane` 이 아직 await 중이다. 세대 토큰이 없으면 나중에 끝난
    // 쪽이 `paneClean` 을 덮어써 **앞 pane 의 독·스캔바·구독이 영영 남는다**
    let paneGen = 0;

    const seg = segment(root.querySelector('#seghost'), [
        { key: PROCESS_PHASE.PRE, label: PROCESS_PHASE_LABEL[PROCESS_PHASE.PRE] },
        { key: PROCESS_PHASE.DONE, label: PROCESS_PHASE_LABEL[PROCESS_PHASE.DONE] },
        { key: SEG_CAL, label: '캘린더' },
    ], state.seg, (key) => {
        state.seg = key;
        openPane();
    });

    /** 세그를 바꿀 때 이전 화면(카메라·독·구독)을 반드시 먼저 정리한다 */
    async function openPane() {
        const gen = (paneGen += 1);
        paneClean?.();
        paneClean = null;
        paneEl.innerHTML = '';
        const clean = state.seg === SEG_CAL
            ? await drawCalendar(paneEl, user)
            : await drawCheckList(paneEl, state.seg);
        // 여는 사이에 세그가 또 바뀌었거나 화면을 떠났다 - 방금 만든 것을 바로 정리한다
        if (gen !== paneGen) {
            clean?.();
            return;
        }
        paneClean = clean;
    }

    await openPane();
    return () => {
        paneGen += 1;      // 준비 중인 pane 이 있으면 스스로 정리하게 한다
        closeAllSheets();
        paneClean?.();
        paneClean = null;
        seg.destroy();
    };
}

/** 작업전·완료 검수 목록 (스캔 바 + 카드) */
async function drawCheckList(host, phase) {
    host.innerHTML = `
<label class="m-search">
  ${icon('search', 'm-icon')}
  <input type="search" id="f-kw" placeholder="문서번호 · 제품코드 · 제품명"
         value="${esc(state.keyword)}" aria-label="검색">
</label>
<p class="m-sum" id="sum"></p>
<p class="m-listtitle">${esc(PROCESS_PHASE_LABEL[phase])} 대상 (작업지시서가 나간 작업)</p>
<div id="list"></div>
<div id="scanhost"></div>
<div id="dockhost"></div>`;

    const sumEl = host.querySelector('#sum');
    const listEl = host.querySelector('#list');

    async function reload() {
        const rows = await db.listProcessJobsForCheck(phase, { keyword: state.keyword });
        sumEl.innerHTML = `<span>대상 <b>${num(rows.length)}</b></span>`;
        listEl.innerHTML = rows.length
            ? rows.map(jobCard).join('')
            : emptyState(state.keyword.trim()
                ? '검색 결과가 없습니다.'
                : `${PROCESS_PHASE_LABEL[phase]}할 작업이 없습니다.`);
    }

    host.querySelector('#f-kw').addEventListener('input', (e) => {
        state.keyword = e.target.value;
        reload();
    });
    listEl.addEventListener('click', (e) => {
        const row = e.target.closest('.m-card[data-id]');
        if (row) location.hash = `#/pcheck/${phase}/${row.dataset.id}`;
    });

    // 독은 화면이 만들어 스캔 바에 넘긴다 (mountScan 은 주문번호 전용이라 쓰지 않는다)
    const d = dock(host.querySelector('#dockhost'));
    const scan = scanBar(host.querySelector('#scanhost'), {
        dock: d,
        placeholder: '작업지시서 문서번호',
        autoFocus: true,
        onSubmit: (code) => openByDocNo(code, phase),
    });

    await reload();
    const unwatch = db.subscribe(pollGuard(host, reload), 5000);
    return () => {
        scan.destroy();
        d.destroy();
        unwatch();
    };
}

/** 목록 카드 - 상태 색은 웹과 같은 토큰(PROCESS_STATUS_TONE)을 쓴다 */
function jobCard(j) {
    const body = `
<span class="m-card__cust">${esc(j.product_name)}</span>
<span class="m-card__meta">${esc(j.work_type)} · ${esc(j.product_code)}
  · ${num(j.qty)}개 · ${esc(j.start_date)} ~ ${esc(j.due_date)}</span>`;
    return card(`<b>${esc(j.doc_no)}</b>`, body, {
        badges: j.photo_count ? tag(`사진 ${j.photo_count}장`, 'blue') : '',
        status: tag(j.status, PROCESS_STATUS_TONE[j.status]),
        attrs: { id: j.id },
        tap: true,
    });
}

/**
 * 문서번호 직접 입력·바코드 스캔.
 * 단계가 맞지 않아도 **연다** - 안내와 함께 맞는 세그로 가는 버튼을 상세가 낸다
 * (경로마다 열리는 작업이 달라지지 않게 한다 · docs/processing.md §17-1).
 */
async function openByDocNo(docNo, phase) {
    const found = await db.findProcessJobByDocNo(docNo);
    if (!found) {
        toast(`문서번호 ${docNo} 를 찾을 수 없습니다.`, 'error');
        return;
    }
    location.hash = `#/pcheck/${phase}/${found.job.id}`;
}

/* ================================= 캘린더 ================================= */

/** `'YYYY-MM'` 에 개월을 더한다 */
function addMonth(month, diff) {
    const [y, m] = String(month).split('-').map(Number);
    const d = new Date(y, m - 1 + diff, 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/** 캘린더 세그 - 배치는 웹과 **같은 순수 함수**(processing-calc)가 한다 */
async function drawCalendar(host, user) {
    async function draw() {
        const jobs = await db.listProcessJobs({});
        const { weeks } = calendarLanes(jobs, state.month, { maxLane: APP_MAX_LANE });
        const byId = new Map(jobs.map((j) => [j.id, j]));

        host.innerHTML = `
<div class="m-datenav">
  <button class="m-btn" id="cal-prev" type="button" aria-label="이전 달">
    ${icon('back', 'm-icon')}</button>
  <strong class="m-cal__month">${esc(state.month)}</strong>
  <button class="m-btn" id="cal-next" type="button" aria-label="다음 달">
    ${icon('forward', 'm-icon')}</button>
  <button class="m-btn" id="cal-today" type="button">오늘</button>
</div>
<div class="m-cal">
  <div class="m-cal__head">
    ${WEEKDAYS.map((w, i) => `<span class="m-cal__dow m-cal__dow--${i}">${esc(w)}</span>`).join('')}
  </div>
  ${weeks.map((week, wi) => weekHtml(week, wi, byId)).join('')}
</div>
<div class="m-cal__legend">
  ${Object.entries(PROCESS_STATUS_TONE).map(([label, tone]) => `
  <span class="m-cal__key"><i class="m-cal-bar--${tone}"></i>${esc(label)}</span>`).join('')}
</div>`;

        host.querySelector('#cal-prev').addEventListener('click', () => {
            state.month = addMonth(state.month, -1);
            draw();
        });
        host.querySelector('#cal-next').addEventListener('click', () => {
            state.month = addMonth(state.month, 1);
            draw();
        });
        host.querySelector('#cal-today').addEventListener('click', () => {
            state.month = today().slice(0, 7);
            draw();
        });
        host.querySelectorAll('[data-job]').forEach((el) => {
            el.addEventListener('click', () => openJobSheet(byId.get(el.dataset.job), user));
        });
        host.querySelectorAll('[data-more]').forEach((el) => {
            el.addEventListener('click', () => {
                const week = weeks[Number(el.dataset.week)];
                const at = Number(el.dataset.more);
                openDaySheet(week.days[at], week.hidden
                    .filter((s) => s.colStart <= at && at < s.colStart + s.colSpan)
                    .map((s) => byId.get(s.jobId))
                    .filter(Boolean), user);
            });
        });
    }

    await draw();
    const unwatch = db.subscribe(pollGuard(host, draw), 10000);
    return () => {
        closeAllSheets();
        unwatch();
    };
}

/** 한 주 - 날짜 칸(배경) 위에 막대 격자를 겹친다 (웹 `.pc-week` 와 같은 구조) */
function weekHtml(week, wi, byId) {
    const bars = week.bars.map((b) => {
        const job = byId.get(b.jobId);
        if (!job) return '';
        return `
<button class="m-cal-bar m-cal-bar--${PROCESS_STATUS_TONE[job.status]}
  ${b.startsHere ? 'is-start' : ''} ${b.endsHere ? 'is-end' : ''}" type="button"
  data-job="${esc(job.id)}"
  style="grid-column:${b.colStart + 1}/span ${b.colSpan};grid-row:${b.lane + 1}"
  >${esc(job.product_name)}</button>`;
    }).join('');

    const more = week.overflow.map((n, i) => (n ? `
<button class="m-cal-more" type="button" data-more="${i}" data-week="${wi}"
  style="grid-column:${i + 1};grid-row:${APP_MAX_LANE + 1}">+${num(n)}</button>` : '')).join('');

    return `
<div class="m-cal__week">
  <div class="m-cal__bg">
    ${week.days.map((d, i) => `
    <span class="m-cal__cell ${d.slice(0, 7) === state.month ? '' : 'is-out'}
      ${d === today() ? 'is-today' : ''}">
      <span class="m-cal__date m-cal__dow--${i}">${Number(d.slice(8, 10))}</span>
    </span>`).join('')}
  </div>
  <div class="m-cal__bars" style="--m-cal-lanes:${APP_MAX_LANE}">${bars}${more}</div>
</div>`;
}

/** 막대를 눌렀을 때 - 요약 + (단계가 맞으면) 검수 화면으로 가는 버튼 */
function openJobSheet(job, user) {
    if (!job) return;
    const editable = db.canCheckProcessing(user);
    const phase = job.pre_check_at ? PROCESS_PHASE.DONE : PROCESS_PHASE.PRE;
    const goable = editable && job.doc_no && !job.done_at;
    const s = sheet(job.product_name, `
<div class="m-kv">
  <div class="m-kv__row"><span class="m-kv__k">문서번호</span>
    <span class="m-kv__v">${esc(job.doc_no ?? '') || '미발행'}</span></div>
  <div class="m-kv__row"><span class="m-kv__k">진행상태</span>
    <span class="m-kv__v">${tag(job.status, PROCESS_STATUS_TONE[job.status])}</span></div>
  <div class="m-kv__row"><span class="m-kv__k">작업구분</span>
    <span class="m-kv__v">${esc(job.work_type)} · ${esc(job.product_code)}</span></div>
  <div class="m-kv__row"><span class="m-kv__k">작업수량</span>
    <span class="m-kv__v">${num(job.qty)}</span></div>
  <div class="m-kv__row"><span class="m-kv__k">기간</span>
    <span class="m-kv__v">${esc(job.start_date)} ~ ${esc(job.due_date)}</span></div>
</div>
${job.doc_no ? '' : '<p class="m-note">작업지시서가 나가야 검수할 수 있습니다 (웹에서 생성).</p>'}`, {
        footer: goable
            ? `<button class="m-btn m-btn--primary" data-go type="button">
                 ${esc(PROCESS_PHASE_LABEL[phase])}로</button>`
            : '',
    });
    s.foot?.querySelector('[data-go]')?.addEventListener('click', () => {
        s.close();
        location.hash = `#/pcheck/${phase}/${job.id}`;
    });
}

/** `+N` 을 눌렀을 때 그 날짜에 숨은 작업 목록 */
function openDaySheet(date, jobs, user) {
    const html = `<div class="m-menu">${jobs.map((j) => `
<button class="m-menu__item" type="button" data-pick="${esc(j.id)}">
  <span>${esc(j.doc_no ?? '') || '미발행'} · ${esc(j.product_name)}</span>
</button>`).join('')}</div>`;
    const s = sheet(`${date} 작업`, html);
    s.body.querySelectorAll('[data-pick]').forEach((el) => {
        el.addEventListener('click', () => {
            s.close();
            openJobSheet(jobs.find((j) => j.id === el.dataset.pick), user);
        });
    });
}

/* ================================== 상세 ================================== */

/** 초안 키 - `${작업}:${단계}:${슬롯}` (같은 자리를 다시 찍으면 덮어쓴다) */
function draftKey(jobId, phase, slot) {
    return `${jobId}:${phase}:${slot}`;
}

/** 이 단계에서 찍어야 할 칸 목록 */
function slotsOf(phase, items) {
    if (phase === PROCESS_PHASE.DONE) {
        return Array.from({ length: PROCESS_DONE_PHOTOS }, (_, i) => ({
            key: String(i + 1),
            label: `완료 사진 ${i + 1}`,
            note: '',
        }));
    }
    // 작업전은 **구성품 줄**마다 1장이다 (LOT 을 나눠도 실물은 한 품목)
    const seen = new Map();
    (items ?? []).forEach((it) => {
        if (!seen.has(it.line_no)) seen.set(it.line_no, it);
    });
    return [...seen.values()]
        .sort((a, b) => a.line_no - b.line_no)
        .map((it) => ({
            key: String(it.line_no),
            label: `${it.line_no}. ${it.name}`,
            note: `${it.kind}${it.code ? ` · ${it.code}` : ''}`,
        }));
}

/**
 * 검수 상세.
 * ⚠️ **실시간 구독을 걸지 않는다.** 촬영 중에 화면을 다시 그리면 초안·파일 선택이 끊긴다.
 * 저장·완료 뒤에는 직접 다시 읽는다.
 */
async function renderDetail(root, user, phase, jobId) {
    const editable = db.canCheckProcessing(user);
    const back = { label: `${PROCESS_PHASE_LABEL[phase]} 목록으로`, href: '#/pcheck' };

    let found = await db.getProcessJob(jobId);
    if (!found) {
        root.innerHTML = emptyState('작업을 찾을 수 없습니다.', back);
        return null;
    }
    if (!found.job.doc_no) {
        root.innerHTML = emptyState('작업지시서를 생성한 뒤에 검수할 수 있습니다.', back);
        return null;
    }

    root.innerHTML = `
<div id="head"></div>
<div id="body"></div>
<div id="dockhost"></div>`;
    const headEl = root.querySelector('#head');
    const bodyEl = root.querySelector('#body');
    const dockCtl = actionDock(root.querySelector('#dockhost'));

    /** 저장된 사진 메타 + 주소 (release 는 정리 함수에서) */
    let metas = [];
    let pack = { urls: new Map(), release() {} };
    /** 저장 전 촬영분 - 슬롯 키 → { blob, url } */
    const drafts = new Map();

    async function loadPhotos() {
        pack.release();
        metas = await db.listProcessPhotos(jobId, phase);
        pack = await db.processPhotoUrls(metas.map((m) => m.path));
    }

    /**
     * 화면을 떠나며 남겨 둔 초안을 되살린다.
     * 🔑 초안은 **보조 장치**다 - 저장소를 못 열어도(사파리 프라이빗 등) 촬영·저장은 되어야 한다.
     */
    async function loadDrafts() {
        const keep = new Set(slotsOf(phase, found.items).map((s) => s.key));
        let rows = [];
        try {
            rows = await idbList(STORE.DRAFTS, `${jobId}:${phase}:`);
        } catch (err) {
            toast(`촬영 임시보관을 쓸 수 없습니다: ${err.message}`, 'error');
            return;
        }
        rows.forEach(({ key, value }) => {
            const slot = key.split(':')[2];
            // 이 단계에 없는 칸의 초안은 화면에 뜨지도 않으면서 저장만 막는다 - 버린다
            if (!keep.has(slot)) {
                forget(key);
                return;
            }
            drafts.set(slot, { blob: value, url: URL.createObjectURL(value) });
        });
    }

    /** 초안 1건 지우기 - 실패해도 진행을 막지 않는다 (이미 서버에는 올라갔다) */
    async function forget(key) {
        try {
            await idbDel(STORE.DRAFTS, key);
        } catch (err) {
            console.warn('초안을 지우지 못했습니다.', err);
        }
    }

    function dropDraft(slot) {
        const cur = drafts.get(slot);
        if (!cur) return;
        URL.revokeObjectURL(cur.url);
        drafts.delete(slot);
    }

    /** 이 슬롯에 저장된 사진 (작업전은 line_no, 완료는 seq 가 슬롯 키다) */
    function metaOf(slot) {
        return metas.find((m) => String(
            phase === PROCESS_PHASE.PRE ? m.line_no : m.seq,
        ) === slot);
    }

    function draw() {
        const { job, items } = found;
        const slots = slotsOf(phase, items);
        const done = Boolean(job.done_at);
        const pre = Boolean(job.pre_check_at);
        // 이 단계에서 더 할 일이 없는 상태는 읽기 전용이다 (되돌리기는 `···` 메뉴)
        const locked = phase === PROCESS_PHASE.PRE ? pre || done : done;
        const readonly = !editable || locked;
        const blocked = phase === PROCESS_PHASE.DONE && !pre;
        const left = slots.filter((s) => !drafts.has(s.key) && !metaOf(s.key));
        const menu = [];
        if (editable && phase === PROCESS_PHASE.PRE && pre && !done) {
            menu.push({
                label: '작업전검수 취소', icon: 'trash', tone: 'danger', onPick: doRevokePre,
            });
        }
        if (editable && phase === PROCESS_PHASE.DONE && done) {
            menu.push({
                label: '완료 취소', icon: 'trash', tone: 'danger', onPick: doRevokeDone,
            });
        }

        headEl.innerHTML = `
<div class="m-ohead">
  <div class="m-ohead__row">
    <h2 class="m-ohead__no">${esc(job.doc_no)}</h2>
    ${tag(job.status, PROCESS_STATUS_TONE[job.status])}
    <span class="m-ohead__spacer"></span>
    ${menu.length ? `<button class="m-ohead__more" type="button" data-more aria-label="더보기"
      >${icon('more', 'm-icon')}</button>` : ''}
  </div>
  <p class="m-ohead__meta">${esc(job.product_name)} · ${esc(job.work_type)}
    · ${num(job.qty)}개 · ${esc(job.start_date)} ~ ${esc(job.due_date)}</p>
</div>`;
        headEl.querySelector('[data-more]')?.addEventListener('click', () => menuSheet(menu));

        bodyEl.innerHTML = `
${blocked ? `
<div class="m-guide">
  <p>작업전 검수를 먼저 마쳐야 합니다.</p>
  <a class="m-btn m-btn--primary" href="#/pcheck/pre/${esc(job.id)}">작업전 검수로</a>
</div>` : ''}
${phase === PROCESS_PHASE.PRE && pre && !done ? `
<div class="m-guide">
  <p>작업전 검수를 마친 작업입니다. 사진은 다시 볼 수 있고, 되돌리려면 위 ··· 메뉴를 쓰세요.</p>
  <a class="m-btn m-btn--primary" href="#/pcheck/done/${esc(job.id)}">완료 검수로</a>
</div>` : ''}
${done ? `
<div class="m-guide"><p>완료된 작업입니다. 조회만 가능합니다.</p></div>` : ''}
<p class="m-listtitle">${esc(PROCESS_PHASE_LABEL[phase])} 사진
  (${num(slots.length - left.length)}/${num(slots.length)})</p>
<div class="m-photos" id="photos">
  ${slots.map((s) => photoSlot({
        ...s,
        url: drafts.get(s.key)?.url ?? pack.urls.get(metaOf(s.key)?.path),
        badge: drafts.has(s.key) ? tag('저장 전', 'amber')
            : (metaOf(s.key) ? tag('저장됨', 'green') : ''),
        readonly: readonly || blocked,
    })).join('')}
</div>
<div class="m-kv">
  <div class="m-kv__row"><span class="m-kv__k">작업전 검수</span>
    <span class="m-kv__v">${job.pre_check_at
        ? `${esc(job.pre_check_by_name)} · ${esc(fmtDateTime(job.pre_check_at))}` : '-'}</span>
  </div>
  <div class="m-kv__row"><span class="m-kv__k">완료 검수</span>
    <span class="m-kv__v">${job.done_at
        ? `${esc(job.done_by_name)} · ${esc(fmtDateTime(job.done_at))}` : '-'}</span></div>
</div>
${editable ? '' : '<p class="m-note">검수 권한이 없어 조회만 가능합니다.</p>'}`;

        bindPhotoSlots(bodyEl.querySelector('#photos'), onPick);
        syncDock({ readonly, blocked, left: left.length });
    }

    /** 하단 독 - 지금 할 수 있는 동작 하나만 남긴다 (취소는 `···` 메뉴) */
    function syncDock({ readonly, blocked, left }) {
        if (readonly || blocked) {
            dockCtl.hide();
            return;
        }
        if (drafts.size) {
            dockCtl.set({
                mode: 'action',
                note: `촬영한 ${drafts.size}장을 저장해야 서버에 올라갑니다.`,
                primary: { label: '저장', tone: 'primary', icon: 'save' },
                onPrimary: doSave,
            });
            return;
        }
        const label = phase === PROCESS_PHASE.PRE ? '검수완료' : '완료처리';
        dockCtl.set({
            mode: 'action',
            note: left ? `사진 ${left}장을 더 촬영해야 합니다.` : '',
            primary: { label, tone: 'go', icon: 'check', disabled: left > 0 },
            onPrimary: doComplete,
        });
    }

    /** 촬영 직후 압축해 초안에 담는다 (원본을 들고 있으면 폰이 죽는다) */
    async function onPick(slot, file) {
        const { blob, size } = await compressPhoto(file);
        dropDraft(slot);
        drafts.set(slot, { blob, url: URL.createObjectURL(blob) });
        draw();
        try {
            await idbPut(STORE.DRAFTS, draftKey(jobId, phase, slot), blob);
        } catch (err) {
            // 임시보관만 실패했다 - 찍은 사진은 화면에 있으니 그 자리에서 저장하면 된다
            toast(`촬영분을 임시보관하지 못했습니다. 바로 저장해 주세요. (${err.message})`, 'error');
            return;
        }
        toast(`사진을 담았습니다 (${num(Math.round(size / 1024))}KB). 저장을 눌러 주세요.`);
    }

    async function doSave() {
        const photos = [...drafts.entries()].map(([slot, v]) => (phase === PROCESS_PHASE.PRE
            ? { line_no: Number(slot), blob: v.blob }
            : { seq: Number(slot), blob: v.blob }));
        try {
            if (phase === PROCESS_PHASE.PRE) await db.savePreCheck(jobId, photos, user);
            else await db.saveDoneCheck(jobId, photos, user);
            // 🔑 실패하면 초안을 **하나도 내리지 않는다.** 어디까지 올라갔는지 db 가 알려
            // 주지 않으므로, 다시 「저장」을 눌러 전부 올린다(경로가 결정적이라 중복이 없다)
            await Promise.all([...drafts.keys()].map(async (slot) => {
                await forget(draftKey(jobId, phase, slot));
                dropDraft(slot);
            }));
            toast('사진을 저장했습니다.', 'success');
        } catch (err) {
            toast(err.message, 'error');
        }
        await refresh();
    }

    async function doComplete() {
        try {
            if (phase === PROCESS_PHASE.PRE) await db.completePreCheck(jobId, user);
            else await db.completeDoneCheck(jobId, user);
            toast(phase === PROCESS_PHASE.PRE
                ? '작업전 검수를 완료했습니다. 작업중으로 바뀝니다.'
                : '작업을 완료했습니다.', 'success');
            location.hash = '#/pcheck';
            return;
        } catch (err) {
            toast(err.message, 'error');
        }
        await refresh();
    }

    async function doRevokePre() {
        if (!await confirmDialog('작업전검수를 취소하시겠습니까?\n사진은 지워지지 않습니다.')) return;
        await run(() => db.revokePreCheck(jobId, user), '작업전검수를 취소했습니다.');
    }

    async function doRevokeDone() {
        if (!await confirmDialog('완료를 취소하시겠습니까?\n사진은 지워지지 않습니다.')) return;
        await run(() => db.revokeProcessDone(jobId, user), '완료를 취소했습니다.');
    }

    /** 처리 후 공통 뒷정리 - 실패 문구는 데이터 계층이 준 것을 그대로 쓴다 */
    async function run(fn, msg) {
        try {
            await fn();
            toast(msg, 'success');
        } catch (err) {
            toast(err.message, 'error');
        }
        await refresh();
    }

    async function refresh() {
        const next = await db.getProcessJob(jobId);
        if (next) found = next;
        await loadPhotos();
        draw();
    }

    await loadPhotos();
    await loadDrafts();
    draw();

    return () => {
        closeAllSheets();
        dockCtl.destroy();
        // 🔑 사진 주소는 화면마다 수십 개가 생긴다 - 놓으면 폰에서 메모리가 샌다
        pack.release();
        [...drafts.keys()].forEach(dropDraft);
    };
}
