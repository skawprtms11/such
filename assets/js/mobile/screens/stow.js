/**
 * 출고적치 (모바일 앱).
 *
 * 목록 → 대상 선택 → **하단 독**으로 로케이션 연속 입력 → 적치완료.
 * 웹 출고주문처리의 출고적치 탭을 한 손 조작에 맞춰 다시 배치한 것이고,
 * 업무 규칙(형식·중복·완료 조건)은 새로 쓰지 않고 db.js · config.js 를 그대로 부른다.
 *
 *   #/stow        적치 대상 목록 (검수완료 · 상차 전)
 *   #/stow/:id    파렛트 목록 + 하단 독
 *
 * 🔑 묶음은 db.getLoadGroup - 대표주문번호 + 추가주문 차수를 함께 본다.
 * 화면에서 다시 묶지 않는다.
 */
import {
    FLOOR_LOCATION, LOCATION_FORMAT, STOW_STATUS, formatLocation, isValidLocation,
} from '../../config.js';
import { can } from '../../auth.js';
import * as db from '../../db.js';
import { icon } from '../../icons.js';
import { createScanner, scanSupported } from '../../scanner.js';
import {
    esc, num, fmtDateTime, toast, confirmDialog,
} from '../../util.js';
import {
    emptyState, tag, plusBadge, card, orderHead, bindOrderHead,
    segment, dock, keypad, scanBar, menuSheet,
} from '../ui.js';

/** 스캐너가 같은 값을 연달아 보내는 것을 무시하는 시간(ms) - 웹 출고적치와 같다 */
const STOW_REPEAT_MS = 2500;

/** 이동 방식 - 연속이동은 첫 미지정 파렛트, 건별이동은 고른 파렛트에 넣는다 */
const STOW_MODES = [
    { key: 'seq', label: '연속이동' },
    { key: 'one', label: '건별이동' },
];

/** 구역코드 입력 방식 - 자동은 앞자리를 따라붙이고, 수기는 넣은 값을 그대로 쓴다 */
const ZONE_MODES = [
    { key: 'auto', label: '자동' },
    { key: 'manual', label: '수기' },
];

/** 적치 입력 설정 - 화면을 다시 열어도 유지한다 (웹 출고적치 탭의 stowPrefs 와 같은 역할) */
const stowPrefs = { mode: 'seq', zoneMode: 'auto', zone: '', keypad: false };

/** 적치 상태 → 배지 색 */
const STATUS_TONE = {
    [STOW_STATUS.DONE]: 'green',
    [STOW_STATUS.ING]: 'blue',
    [STOW_STATUS.WAIT]: 'gray',
};

/** 목록 조회 조건 - 상세를 다녀와도 유지한다 */
const filter = { keyword: '' };

/** 현장에서 화면을 못 볼 때의 피드백 (성공은 짧게, 실패·중복은 세 번) */
function buzz(ok) {
    if (navigator.vibrate) navigator.vibrate(ok ? 60 : [70, 70, 70]);
}

/** 로케이션 표시 - 바닥 적치는 좌표가 없어 `평치` 로 나온다 */
function locationHtml(location) {
    if (!location) return '<span class="m-muted">미지정</span>';
    const v = formatLocation(location);
    return v === FLOOR_LOCATION
        ? `${icon('floor', 'm-icon')}<b>${esc(v)}</b>`
        : `<b>${esc(v)}</b>`;
}

export async function render(root, { user, params }) {
    return params[0]
        ? renderDetail(root, user, params[0])
        : renderList(root, user);
}

/* =============================== 목록 (§3-4a) =============================== */

async function renderList(root, user) {
    root.innerHTML = `
<label class="m-search">
  ${icon('search', 'm-icon')}
  <input type="search" id="f-kw" placeholder="주문번호 · 대표주문번호 · 거래처명"
         value="${esc(filter.keyword)}" aria-label="검색">
</label>
<p class="m-sum" id="sum"></p>
<div id="list"></div>
<div id="scanhost"></div>
<div id="dockhost"></div>`;

    const listEl = root.querySelector('#list');
    // 독은 화면이 만들어 소유하고 스캔 바에 넘긴다 (한 화면에 독은 하나뿐이다)
    const d = dock(root.querySelector('#dockhost'), {});
    const scan = scanBar(root.querySelector('#scanhost'), {
        dock: d,
        placeholder: '주문번호 · 대표주문번호',
        onSubmit: open,
    });

    /** 스캔·직접 입력으로 주문을 연다 (라벨이 젖어 못 읽으면 목록에서 고른다) */
    async function open(code) {
        const rows = await db.findOrdersByNo(code);
        if (!rows.length) {
            scan.result.show(`${code} 주문을 찾을 수 없습니다.`, false);
            buzz(false);
            return;
        }
        scan.result.clear();
        buzz(true);
        location.hash = `#/stow/${rows[0].id}`;
    }

    async function reload() {
        const rows = await db.listStowTargets({
            createdBy: can(user, 'viewAll') ? '' : user.id,
            keyword: filter.keyword,
        });
        draw(rows);
    }

    function draw(rows) {
        const count = (s) => rows.filter((o) => o.stow_status === s).length;
        root.querySelector('#sum').innerHTML = rows.length ? `
<span>대기 <b>${num(count(STOW_STATUS.WAIT))}</b></span>
<span>적치중 <b>${num(count(STOW_STATUS.ING))}</b></span>
<span>완료 <b>${num(count(STOW_STATUS.DONE))}</b></span>` : '';

        listEl.innerHTML = rows.length
            ? rows.map(stowCard).join('')
            : emptyState('적치 대상 주문이 없습니다. (검수작업이 끝나고 상차 전인 주문만 나옵니다)');
    }

    root.querySelector('#f-kw').addEventListener('input', (e) => {
        filter.keyword = e.target.value;
        reload();
    });

    listEl.addEventListener('click', (e) => {
        const row = e.target.closest('.m-card[data-id]');
        if (row) location.hash = `#/stow/${row.dataset.id}`;
    });

    await reload();
    // 검색어를 치는 중에 목록이 다시 그려지면 입력이 끊긴다
    const poll = () => {
        if (root.contains(document.activeElement)
            && document.activeElement.matches('input')) return;
        reload();
    };
    const unwatch = db.subscribe(poll, 8000);
    return () => {
        scan.destroy();
        d.destroy();
        unwatch();
    };
}

/** 목록 카드 한 장 - 적치 진행은 상차 묶음 전체 기준이다 */
function stowCard(o) {
    const no = esc(o.group_no);
    const total = o.group_pallets ?? 0;
    const done = o.group_stowed ?? 0;
    const body = `
<span class="m-card__cust">${esc(o.customer)}</span>
<span class="m-card__meta">${esc(o.vehicle_type)}
  · 출고 ${esc(o.ship_req_date ?? '미정')}</span>`;

    return card(o.rep_no ? `<b>${no}</b>` : no, body, {
        badges: `${o.rep_no ? tag('대표', 'amber') : ''}${plusBadge(o.group_count)}`,
        status: tag(o.stow_status, STATUS_TONE[o.stow_status] ?? 'gray'),
        bar: { done, total, label: `${done}/${total} PLT` },
        attrs: { id: o.id },
        tap: true,
    });
}

/* ============================ 상세 (§3-4 b·c·d·e) ============================ */

async function renderDetail(root, user, orderId) {
    let g = await db.getLoadGroup(orderId);
    if (!g) {
        root.innerHTML = emptyState('주문을 찾을 수 없습니다.',
            { label: '적치 목록으로', href: '#/stow' });
        return null;
    }
    const editable = can(user, 'updateStatus');
    const headMeta = (o) => `${esc(o.customer)} · ${esc(o.vehicle_type)}`
        + ` · 출고 ${esc(o.ship_req_date ?? '미정')}`;

    // 검수작업이 끝나야 파렛트가 생긴다. 헛걸음하지 않도록 검수작업으로 보내 준다
    if (!g.head.inspect_done_at) {
        root.innerHTML = orderHead(g.head, { group: g, meta: headMeta(g.head) })
            + emptyState('검수작업이 완료되지 않은 주문입니다. 검수작업을 먼저 끝내세요.',
                { label: '검수작업으로', href: `#/inspect/${orderId}` });
        return null;
    }

    let prog = await db.stowProgress(orderId);
    let pallets = g.pallets;
    let selectedId = null;      // 건별이동에서 고른 파렛트
    let moved = [];             // 이번 화면에서 이동 처리한 파렛트 id (먼저 넣은 것이 앞)
    let lastValue = '';         // 스캐너 중복 발사를 막기 위한 직전 입력값
    let lastAt = 0;
    let dockMode = '';
    let openSheet = null;

    root.innerHTML = `
<div id="head"></div>
<div id="top"></div>
<div id="camhost"></div>
<div id="list"></div>
<div class="m-stowfix__space" id="space"></div>
<div class="m-stowfix" id="fix" hidden>
  <p class="m-stowbanner" id="banner"></p>
  <div class="m-stowtools" id="tools"></div>
  <p class="m-stowpreview" id="preview" hidden></p>
  <p class="m-stownote" id="note" hidden></p>
  <div id="dockhost"></div>
  <div id="padhost"></div>
  <div class="m-stowset" id="set">
    <div id="seg-mode"></div>
    <label class="m-stowset__zone" id="zone-box">
      <span>구역</span>
      <input type="text" id="zone-code" maxlength="2" placeholder="IF"
             autocomplete="off" aria-label="구역코드">
    </label>
    <div id="seg-zone"></div>
  </div>
</div>`;

    const headEl = root.querySelector('#head');
    const topEl = root.querySelector('#top');
    const listEl = root.querySelector('#list');
    const camHost = root.querySelector('#camhost');
    const fixEl = root.querySelector('#fix');
    const spaceEl = root.querySelector('#space');
    const bannerEl = root.querySelector('#banner');
    const toolsEl = root.querySelector('#tools');
    const previewEl = root.querySelector('#preview');
    const noteEl = root.querySelector('#note');
    const zoneBox = root.querySelector('#zone-box');
    const zoneEl = root.querySelector('#zone-code');

    /* ------------------------------ 부품 만들기 ------------------------------ */

    const d = editable ? dock(root.querySelector('#dockhost'), dockSpec()) : null;
    const pad = editable
        ? keypad(root.querySelector('#padhost'), { target: d.input, onToggle: syncFixed })
        : null;
    const modeSeg = editable
        ? segment(root.querySelector('#seg-mode'), STOW_MODES, stowPrefs.mode, setMode)
        : null;
    const zoneSeg = editable
        ? segment(root.querySelector('#seg-zone'), ZONE_MODES, stowPrefs.zoneMode, setZoneMode)
        : null;

    // 로케이션 라벨을 카메라로 읽는다. 켜 둔 채로 연속 입력할 수 있다
    const camBox = document.createElement('div');
    camBox.className = 'm-scanbox';
    camBox.hidden = true;
    camBox.innerHTML = `
<video class="m-scanbox__video" playsinline muted></video>
<span class="m-scanbox__aim"></span>`;
    camHost.appendChild(camBox);
    const scanner = editable && scanSupported()
        ? createScanner(camBox.querySelector('video'), (code) => submit(code))
        : null;

    /* ------------------------------ 대상 계산 ------------------------------ */

    /** 지금 로케이션을 넣을 파렛트 (연속이동은 첫 미지정, 건별이동은 고른 것) */
    function target() {
        if (stowPrefs.mode === 'one') return pallets.find((p) => p.id === selectedId) ?? null;
        return pallets.find((p) => !p.location) ?? null;
    }

    /** 묶음 안에서 파렛트를 가진 주문 (대개 대표 1건 - 파렛트는 대표에 모인다) */
    function owners() {
        const ids = new Set(pallets.map((p) => p.order_id));
        return g.rows.filter((r) => ids.has(r.id));
    }

    /**
     * 입력값을 로케이션으로 만든다.
     * 구역코드가 `자동` 이고 숫자만 들어오면 앞에 구역코드를 붙인다 (010203 → IF-01-02-03).
     * `수기` 이거나 영문이 섞여 들어오면(로케이션 바코드 스캔) 넣은 값을 그대로 쓴다.
     */
    function compose(raw) {
        const s = String(raw ?? '').trim();
        if (!s) return '';
        if (stowPrefs.zoneMode === 'auto' && stowPrefs.zone && !/[a-zA-Z]/.test(s)) {
            return formatLocation(stowPrefs.zone + s);
        }
        return formatLocation(s);
    }

    /**
     * 목록에 뿌릴 순서.
     * 연속이동은 **방금 이동한 것이 맨 위**로 와야 눈으로 바로 확인할 수 있다.
     * 건별이동은 목록에서 골라야 하므로 파렛트 번호순을 그대로 둔다.
     */
    function ordered() {
        if (stowPrefs.mode !== 'seq' || !moved.length) return pallets;
        const recent = [...moved].reverse()
            .map((id) => pallets.find((p) => p.id === id))
            .filter(Boolean);
        return [...recent, ...pallets.filter((p) => !moved.includes(p.id))];
    }

    /* -------------------------------- 그리기 -------------------------------- */

    function draw() {
        const o = g.head;
        headEl.innerHTML = orderHead(o, {
            group: g,
            meta: headMeta(o),
            note: g.rows.length > 1
                ? `묶인 주문 ${g.rows.length}건을 함께 적치합니다`
                    + ` (${esc(g.rows.map((r) => r.order_no).join(', '))}).`
                : '',
            more: editable,
        });
        bindOrderHead(headEl, { onMore: openMenu });
        drawStatus();
        drawList();
        drawBanner();
        drawTools();
        drawModes();
        syncDock();
    }

    /** 상태 카드 - 위험 조작(적치취소)은 여기 두지 않고 `···` 메뉴에만 둔다 */
    function drawStatus() {
        const at = g.rows.find((r) => r.stow_done_at)?.stow_done_at;
        topEl.innerHTML = `
<div class="m-statline">
  ${tag(prog.status, STATUS_TONE[prog.status] ?? 'gray')}
  <span>적치 ${num(prog.done)}/${num(prog.total)}</span>
  ${at ? `<b>${esc(fmtDateTime(at))}</b>` : ''}
</div>
${prog.stowed ? '<p class="m-note">적치완료된 주문입니다.'
        + ' 값을 고치려면 위 ··· 메뉴에서 적치취소하세요.</p>' : ''}
${editable ? '' : '<p class="m-note">처리 권한이 없어 조회만 가능합니다.</p>'}`;
    }

    function drawList() {
        if (!pallets.length) {
            listEl.innerHTML = emptyState('파렛트가 없습니다. 검수작업에서 파렛트수를 입력하세요.',
                { label: '검수작업으로', href: `#/inspect/${orderId}` });
            return;
        }
        const t = target();
        const mark = (p) => (p.location ? 'check' : (p.id === t?.id ? 'next' : 'square'));
        listEl.innerHTML = `
<p class="m-listtitle">파렛트 ${stowPrefs.mode === 'seq' ? '(최근 이동순)' : '(번호순)'}</p>
${ordered().map((p) => `
<button class="m-pallet ${p.location ? 'is-done' : ''} ${p.id === t?.id ? 'is-target' : ''}"
        type="button" data-pallet="${esc(p.id)}" ${editable ? '' : 'disabled'}>
  <span class="m-pallet__mark">${icon(mark(p), 'm-icon')}</span>
  <span class="m-pallet__name">${esc(p.label)}</span>
  <span class="m-pallet__loc">${locationHtml(p.location)}</span>
</button>`).join('')}`;

        listEl.querySelectorAll('[data-pallet]').forEach((el) => {
            el.addEventListener('click', () => pick(el.dataset.pallet));
        });
    }

    /** 대상 배너 - "지금 어디에 넣는가"의 유일한 진실 (독 바로 위 · 큰 글씨) */
    function drawBanner() {
        if (!editable) return;
        const t = target();
        const rest = pallets.filter((p) => !p.location).length;

        if (!pallets.length) {
            bannerEl.className = 'm-stowbanner is-wait';
            bannerEl.innerHTML = '검수작업에서 파렛트수를 먼저 입력하세요.';
        } else if (!t && stowPrefs.mode === 'one') {
            bannerEl.className = 'm-stowbanner is-wait';
            bannerEl.innerHTML = '아래 목록에서 파렛트를 선택하세요.';
        } else if (!t) {
            bannerEl.className = 'm-stowbanner is-done';
            bannerEl.innerHTML = `${icon('check', 'm-icon')}
<span>모든 파렛트의 적치가 끝났습니다.</span>`;
        } else {
            bannerEl.className = 'm-stowbanner';
            bannerEl.innerHTML = `
<span class="m-stowbanner__label">${stowPrefs.mode === 'one' ? '선택' : '다음 대상'}</span>
<b>${esc(t.label)}</b>
${t.location
        ? tag(formatLocation(t.location), 'green')
        : `<span class="m-stowbanner__rest">남은 ${num(rest)}건</span>`}`;
        }
    }

    /** 도구 줄 4칸 - 평치 · 카메라 · 자판 · 지우기(대상에 값이 있을 때만) */
    function drawTools() {
        if (!editable) return;
        const t = target();
        const camOn = Boolean(scanner?.isOn());
        const cell = (name, key, label, cls = '') => `
<button class="m-tool ${cls}" type="button" data-tool="${key}">
  ${icon(name, 'm-icon')}<span>${esc(label)}</span></button>`;

        toolsEl.innerHTML = [
            cell('floor', 'floor', '평치'),
            scanner
                ? cell(camOn ? 'stop' : 'camera', 'cam', camOn ? '중지' : '카메라',
                    camOn ? 'is-on' : '')
                : '<span class="m-tool is-empty"></span>',
            cell('keypad', 'pad', '자판', pad?.isOpen() ? 'is-on' : ''),
            t?.location
                ? cell('trash', 'clear', '지우기', 'is-danger')
                : '<span class="m-tool is-empty"></span>',
        ].join('');
    }

    /** 입력 중인 값을 형식에 맞춰 크게 보여준다 (형식이 완성되면 초록) */
    function drawPreview() {
        if (!editable) return;
        const v = compose(d.value());
        previewEl.hidden = !v || dockMode !== 'input';
        previewEl.textContent = v;
        previewEl.classList.toggle('is-ready', isValidLocation(v));
        syncFixed();
    }

    /** 설정 줄(이동 방식 · 구역코드) 표시를 맞춘다 */
    function drawModes() {
        if (!editable) return;
        modeSeg.set(stowPrefs.mode);
        zoneSeg.set(stowPrefs.zoneMode);
        const auto = stowPrefs.zoneMode === 'auto';
        zoneEl.value = stowPrefs.zone;
        zoneEl.disabled = !auto;
        zoneBox.classList.toggle('is-warn', auto && !stowPrefs.zone);
        // 구역코드가 비어 있으면 숫자만 넣어도 로케이션이 되지 않는다
        noteEl.hidden = !(auto && !stowPrefs.zone);
        noteEl.textContent = '구역코드를 먼저 넣으세요. 이후 입력에 계속 따라붙습니다.';
        if (dockMode === 'input') d.set(dockSpec());
    }

    /* -------------------------------- 하단 독 -------------------------------- */

    /** 자동+구역코드가 정해졌으면 숫자만 받으면 되므로 숫자 자판을 띄운다 */
    function dockSpec() {
        const auto = stowPrefs.zoneMode === 'auto' && Boolean(stowPrefs.zone);
        return {
            mode: 'input',
            input: {
                placeholder: auto ? '010203' : LOCATION_FORMAT,
                inputmode: auto ? 'numeric' : 'text',
            },
            primary: { label: '저장', tone: 'go' },
            onPrimary: () => submit(d.value()),
            onSubmit: (v) => submit(v),
        };
    }

    /** 전량 입력되면 독이 통째로 `적치완료` 버튼이 된다 (§3-4d) */
    function syncDock() {
        const done = prog.stowed;
        fixEl.hidden = !editable || done;
        if (fixEl.hidden) {
            stopCam();
            syncFixed();
            return;
        }
        const allFilled = pallets.length > 0 && pallets.every((p) => p.location);
        const next = allFilled ? 'action' : 'input';
        if (next !== dockMode) {
            dockMode = next;
            if (allFilled) {
                stopCam();
                pad.toggle(false);
                d.set({
                    mode: 'action',
                    primary: { label: '적치완료', tone: 'go', icon: 'stow' },
                    onPrimary: doComplete,
                });
            } else {
                d.set(dockSpec());
                pad.setTarget(d.input);
                if (stowPrefs.keypad) pad.toggle(true);
            }
        }
        toolsEl.hidden = allFilled;
        previewEl.hidden = allFilled || !previewEl.textContent;
        syncFixed();
    }

    /** 하단 고정 영역이 본문을 가리지 않도록 같은 높이의 빈 칸을 남긴다 */
    function syncFixed() {
        spaceEl.style.height = fixEl.hidden ? '0px' : `${fixEl.offsetHeight}px`;
    }

    /**
     * 소프트 키보드가 올라오면 고정 영역을 그 위로 끌어올린다.
     * 레이아웃(고정 배치)은 그대로 두고 위치만 보정한다 - 자판을 펼쳐도 화면이 튀지 않는다.
     */
    function syncViewport() {
        const vv = window.visualViewport;
        if (!vv) return;
        const gap = Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop));
        fixEl.style.bottom = gap ? `${gap}px` : '';
        syncFixed();
    }

    /* -------------------------------- 동작 -------------------------------- */

    /** 입력칸을 비우고 커서를 되돌린다 (스캐너 연속 입력) */
    function resetInput() {
        if (!d) return;
        d.clear();
        drawPreview();
        if (dockMode === 'input') d.focus();
    }

    /** 목록에서 파렛트를 고른다. 연속이동 중이면 건별이동으로 넘어간다 */
    function pick(palletId) {
        if (!editable) return;
        if (stowPrefs.mode !== 'one') {
            stowPrefs.mode = 'one';
            toast('건별이동으로 바꿨습니다.', 'info');
        }
        selectedId = palletId;
        drawModes();
        drawList();
        drawBanner();
        drawTools();
        resetInput();
    }

    function setMode(key) {
        stowPrefs.mode = key;
        // 건별이동으로 바꿨는데 고른 것이 없으면 첫 미지정 파렛트부터 시작한다
        if (key === 'one' && !selectedId) {
            selectedId = pallets.find((p) => !p.location)?.id ?? null;
        }
        drawModes();
        drawList();
        drawBanner();
        drawTools();
        resetInput();
    }

    function setZoneMode(key) {
        stowPrefs.zoneMode = key;
        drawModes();
        drawPreview();
        d.focus();
    }

    /** 로케이션 저장 */
    async function save(pallet, value) {
        try {
            await db.setPalletLocation(pallet.id, value);
            toast(`${pallet.label} → ${value}`, 'success');
            buzz(true);
            moved = [...moved.filter((id) => id !== pallet.id), pallet.id];
            // 건별이동도 저장 뒤에는 다음 미지정 파렛트로 옮겨 이어서 넣게 한다
            const from = pallets.indexOf(pallet);
            selectedId = pallets.find((p, i) => i > from && !p.location)?.id
                ?? pallets.find((p) => !p.location && p.id !== pallet.id)?.id
                ?? null;
            await refresh();
        } catch (err) {
            toast(err.message, 'error');
        }
        resetInput();
    }

    /**
     * 입력 확정.
     * 스캐너가 같은 값을 연달아 보내면 2.5초 안에는 무시하고,
     * 이미 다른 파렛트에 들어간 로케이션이면 알리고 다시 받는다.
     */
    async function submit(raw) {
        if (!editable) return;
        const t = target();
        if (!t) {
            toast('로케이션을 넣을 파렛트가 없습니다.', 'error');
            return;
        }
        const v = compose(raw);
        if (!isValidLocation(v)) {
            toast(`로케이션은 ${LOCATION_FORMAT} 형식으로 입력하세요.`, 'error');
            resetInput();
            return;
        }

        const now = performance.now();
        if (v === lastValue && now - lastAt < STOW_REPEAT_MS) {
            resetInput();          // 스캐너 중복 발사 - 조용히 넘긴다
            return;
        }
        lastValue = v;
        lastAt = now;

        // 평치는 좌표가 없어 여러 파렛트가 같은 값을 가진다 - 중복 검사에서 뺀다
        const dup = v === FLOOR_LOCATION ? null : pallets.find((p) => p.id !== t.id
            && p.location && formatLocation(p.location) === v);
        if (dup) {
            toast(`${v} 는 ${dup.label} 에 이미 들어간 로케이션입니다. 다시 스캔하세요.`, 'error');
            buzz(false);
            resetInput();
            return;
        }

        await save(t, v);
    }

    /** 지우기 - 잘못 넣은 로케이션을 비운다 */
    async function doClear(t) {
        if (!t?.location) return;
        try {
            await db.clearPalletLocation(t.id);
            toast('로케이션을 지웠습니다.', 'success');
            moved = moved.filter((id) => id !== t.id);
            lastValue = '';
            selectedId = stowPrefs.mode === 'one' ? t.id : null;
            await refresh();
        } catch (err) {
            toast(err.message, 'error');
        }
        resetInput();
    }

    /** 적치완료 - 파렛트를 가진 주문마다 차례로 찍는다 (동시에 저장하면 서로 덮어쓴다) */
    async function doComplete() {
        try {
            for (const o of owners()) {
                if (!o.stow_done_at) await db.completeStow(o.id, user);
            }
            toast('출고적치를 완료했습니다.', 'success');
            buzz(true);
        } catch (err) {
            toast(err.message, 'error');
        }
        await refresh();
    }

    /** 적치취소 - `···` 메뉴 + 확인 대화상자로만 부른다 */
    async function doCancel() {
        const no = g.head.rep_no || g.head.order_no;
        const ok = await confirmDialog(`${no} 의 적치를 취소하시겠습니까?\n\n`
            + `입력한 로케이션 ${prog.done}건이 모두 지워지고 처음부터 다시 넣어야 합니다.`);
        if (!ok) return;
        try {
            for (const o of owners()) {
                const has = o.stow_done_at
                    || pallets.some((p) => p.order_id === o.id && p.location);
                if (has) await db.cancelStow(o.id, user);
            }
            toast('출고적치를 취소했습니다.', 'success');
            moved = [];
            selectedId = null;
            lastValue = '';
        } catch (err) {
            toast(err.message, 'error');
        }
        await refresh();
    }

    function openMenu() {
        openSheet = menuSheet(
            [{ label: '적치취소', icon: 'back', tone: 'danger', onPick: doCancel }],
            g.head.rep_no || g.head.order_no,
        );
    }

    async function startCam() {
        if (!scanner) return;
        try {
            await scanner.start();
            camBox.hidden = false;
            camBox.scrollIntoView({ behavior: 'smooth', block: 'end' });
        } catch (err) {
            toast(err.message, 'error');
        }
        drawTools();
    }

    function stopCam() {
        if (!scanner?.isOn()) return;
        scanner.stop();
        camBox.hidden = true;
        drawTools();
    }

    async function refresh() {
        const [next, p] = await Promise.all([db.getLoadGroup(orderId), db.stowProgress(orderId)]);
        if (!next || !p) return;
        g = next;
        prog = p;
        pallets = g.pallets;
        if (selectedId && !pallets.some((x) => x.id === selectedId)) selectedId = null;
        draw();
    }

    /* ------------------------------ 이벤트 연결 ------------------------------ */

    if (editable) {
        d.input.addEventListener('input', drawPreview);

        toolsEl.addEventListener('click', (e) => {
            const btn = e.target.closest('[data-tool]');
            if (!btn) return;
            const t = target();
            if (btn.dataset.tool === 'floor') {
                if (!t) toast('평치로 옮길 파렛트가 없습니다.', 'error');
                else save(t, FLOOR_LOCATION);
            } else if (btn.dataset.tool === 'cam') {
                if (scanner?.isOn()) stopCam();
                else startCam();
            } else if (btn.dataset.tool === 'pad') {
                stowPrefs.keypad = pad.toggle();
                drawTools();
            } else if (btn.dataset.tool === 'clear') {
                doClear(t);
            }
        });

        zoneEl.addEventListener('input', (e) => {
            // 구역코드는 영문 2자리만 받는다
            e.target.value = e.target.value.replace(/[^a-zA-Z]/g, '').toUpperCase().slice(0, 2);
            stowPrefs.zone = e.target.value;
            drawModes();
            drawPreview();
            if (stowPrefs.zone.length === 2) d.focus();
        });

        window.visualViewport?.addEventListener('resize', syncViewport);
        window.visualViewport?.addEventListener('scroll', syncViewport);
    }

    draw();
    if (pad && stowPrefs.keypad) pad.toggle(true);
    syncViewport();

    // 입력 중에 다시 그리면 손이 튄다 (목록과 같은 가드)
    const poll = () => {
        if (root.contains(document.activeElement)
            && document.activeElement.matches('input')) return;
        refresh();
    };
    const unwatch = db.subscribe(poll, 8000);

    return () => {
        stopCam();
        scanner?.stop();
        window.visualViewport?.removeEventListener('resize', syncViewport);
        window.visualViewport?.removeEventListener('scroll', syncViewport);
        pad?.destroy();
        modeSeg?.destroy();
        zoneSeg?.destroy();
        d?.destroy();
        openSheet?.close();
        unwatch();
    };
}
