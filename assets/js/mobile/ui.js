/**
 * 모바일 앱 공통 컴포넌트 (m.html 전용).
 *
 * 프레임워크가 없으므로 **"HTML 문자열을 만드는 함수 + 이벤트를 붙이는 함수"** 쌍으로 만든다.
 * 화면(screens/**)은 여기서 만든 조각만 조립하고 업무 규칙은 db.js 에 맡긴다.
 *
 * ⚠️ 모달은 util.openModal 을 쓰지 않는다. 모바일에서는 화면 가운데 뜨는 모달이
 * 손가락에서 멀고 상단바·독과 겹치므로 **아래에서 올라오는 sheet() 를 쓴다.**
 *
 * ⚠️ 클래스는 전부 `m-` 접두를 쓴다. app.css 의 클래스(.tag .seq .bar .pallet)를
 * 재사용하지 않는다 - 웹 스타일을 정리할 때 서로를 깨뜨리지 않기 위해서다.
 * 그래서 util.js 의 addBadge() · seqTag() 대신 같은 모양을 여기서 다시 만든다.
 */
import { icon } from '../icons.js';
import { esc, num, rate, toast } from '../util.js';
import { createScanner, scanSupported } from '../scanner.js';

/** 버튼 색조 → 클래스 (주 동작은 초록, 위험은 빨강) */
const TONE = {
    go: 'm-btn--go',
    primary: 'm-btn--primary',
    danger: 'm-btn--danger',
    plain: '',
};

/* --------------------------------- 표시 조각 --------------------------------- */

/**
 * 빈 화면 + 다음 행동 버튼.
 * @param {string} msg 안내 문구
 * @param {{label:string, href:string}|null} action 다음 행동 버튼
 */
export function emptyState(msg, action = null) {
    const btn = action
        ? `<a class="m-btn m-btn--primary" href="${esc(action.href)}">${esc(action.label)}</a>`
        : '';
    return `<div class="m-empty"><p class="m-empty__msg">${esc(msg)}</p>${btn}</div>`;
}

/** 상태 배지 */
export function tag(label, tone = 'gray') {
    return `<span class="m-tag m-tag--${tone}">${esc(label)}</span>`;
}

/** 차수 배지 - 2차수 이상은 주황으로 구분한다 */
export function seqTag(seq, suffix = '차') {
    return `<span class="m-seq ${seq > 1 ? 'is-multi' : ''}">${esc(seq)}${suffix}</span>`;
}

/** 묶인 건수 배지 - 묶음 대표 행에만 붙인다 */
export function plusBadge(count) {
    return count > 1 ? `<span class="m-tag m-tag--amber">+${count - 1}건</span>` : '';
}

/** 진행 막대 (100%면 초록) */
export function progressBar(done, total, label = '') {
    const pct = rate(done, total);
    return `
<div class="m-bar">
  <div class="m-bar__track">
    <div class="m-bar__fill ${pct === 100 ? 'is-done' : ''}" style="width:${pct}%"></div>
  </div>
  ${label ? `<span class="m-bar__label">${esc(label)}</span>` : ''}
</div>`;
}

/**
 * 큰 진행 카운터 - 현장에서 "몇 개 남았나" 하나만 보면 되도록 크게 그린다.
 * @param {number} done 완료 수
 * @param {number} total 전체 수
 * @param {string} note 카운터 아래 한 줄 (예: '남은 파렛트 6개')
 */
export function bigCounter(done, total, note = '') {
    const pct = rate(done, total);
    return `
<div class="m-counter ${pct === 100 ? 'is-done' : ''}">
  <strong class="m-counter__num">${num(done)}<span> / </span>${num(total)}</strong>
  ${note ? `<span class="m-counter__note">${esc(note)}</span>` : ''}
  ${progressBar(done, total)}
</div>`;
}

/**
 * 단계 흐름 칩. steps.js 의 stepsFlowHtml 은 app.css 클래스를 쓰므로
 * 같은 데이터(visibleSteps 결과)를 받아 모바일 마크업으로 다시 그린다.
 * @param {Array<{label:string, done:boolean, current:boolean}>} steps
 */
export function stepBar(steps) {
    return `<div class="m-steps">${steps.map((s) => `
<span class="m-step ${s.done ? 'is-done' : ''} ${s.current ? 'is-current' : ''}"
  >${esc(s.label)}</span>`).join('')}</div>`;
}

/**
 * 목록 카드.
 * @param {string} title 제목 (호출부가 이미 이스케이프한 HTML)
 * @param {string} body 본문 (호출부가 이미 이스케이프한 HTML)
 * @param {{badges?:string, status?:string, bar?:{done:number,total:number,label?:string},
 *          actions?:string, attrs?:object, tap?:boolean}} opt
 *   attrs - 이벤트를 걸 때 쓰는 data 속성 (`{id:'o_1'}` → `data-id="o_1"`)
 */
export function card(title, body, {
    badges = '', status = '', bar = null, actions = '', attrs = {}, tap = false,
} = {}) {
    const at = Object.entries(attrs)
        .map(([k, v]) => ` data-${k}="${esc(v)}"`).join('');
    return `
<div class="m-card ${tap ? 'is-tap' : ''}"${at}>
  <div class="m-card__top">
    <span class="m-card__title">${title}</span>${badges}
    <span class="m-card__spacer"></span>${status}
  </div>
  ${body ? `<div class="m-card__body">${body}</div>` : ''}
  ${bar ? progressBar(bar.done, bar.total, bar.label ?? '') : ''}
  ${actions ? `<div class="m-card__actions">${actions}</div>` : ''}
</div>`;
}

/**
 * 상세 화면의 주문 요약 헤더 (대표 배지 · 묶인 주문 안내 · `···` 메뉴).
 * @param {object} order 묶음 대표 주문
 * @param {{group?:object, meta?:string, note?:string, more?:boolean}} opt
 *   group - db.getLoadGroup / getBatchGroup 결과 (묶인 건수 배지에 쓴다)
 *   meta  - 거래처·출고형태 등 한 줄 요약 (이스케이프된 HTML)
 *   note  - 묶음 안내 문구 (묶음 용도가 화면마다 달라 호출부가 정한다)
 *   more  - `···` 메뉴 버튼 표시 여부 (위험 조작은 이 메뉴 안에만 둔다)
 */
export function orderHead(order, { group = null, meta = '', note = '', more = false } = {}) {
    const rows = group?.rows ?? [];
    return `
<div class="m-ohead">
  <div class="m-ohead__row">
    <h2 class="m-ohead__no">${esc(order.rep_no || order.order_no)}</h2>
    ${order.rep_no ? tag('대표', 'amber') : ''}
    ${rows.length > 1 ? tag(`${rows.length}건`, 'blue') : ''}
    <span class="m-ohead__spacer"></span>
    ${more ? `<button class="m-ohead__more" type="button" data-more aria-label="더보기"
      >${icon('more', 'm-icon')}</button>` : ''}
  </div>
  ${meta ? `<p class="m-ohead__meta">${meta}</p>` : ''}
  ${note ? `<p class="m-ohead__note">${note}</p>` : ''}
</div>`;
}

/** orderHead 의 `···` 버튼에 이벤트를 건다 */
export function bindOrderHead(root, { onMore } = {}) {
    root.querySelector('[data-more]')?.addEventListener('click', () => onMore?.());
}

/**
 * 스캔 결과 상주 줄 - 토스트는 놓치기 쉬워 마지막 결과를 화면에 남겨 둔다.
 * 진동은 상황(성공/실패)마다 세기가 달라 호출부가 울린다.
 */
export function resultLine(host) {
    const el = document.createElement('p');
    el.className = 'm-result';
    el.hidden = true;
    host.appendChild(el);
    return {
        show(msg, ok) {
            el.hidden = false;
            el.className = `m-result ${ok ? 'is-ok' : 'is-bad'}`;
            el.innerHTML = `${icon(ok ? 'check' : 'issues', 'm-icon')}<span>${esc(msg)}</span>`;
        },
        clear() {
            el.hidden = true;
        },
        destroy() {
            el.remove();
        },
    };
}

/* --------------------------------- 세그먼트 --------------------------------- */

/**
 * 세그먼트 컨트롤 (상차검수 | 로케이션 등).
 * @param {Element} host 그릴 자리
 * @param {Array<{key:string, label:string}>} items
 * @param {string} activeKey 처음 선택된 키
 * @param {(key:string) => void} onChange
 */
export function segment(host, items, activeKey, onChange) {
    const el = document.createElement('div');
    el.className = 'm-seg';
    host.appendChild(el);
    let cur = activeKey;

    function draw() {
        el.innerHTML = items.map((it) => `
<button class="m-seg__btn ${it.key === cur ? 'is-active' : ''}" type="button"
        data-key="${esc(it.key)}">${esc(it.label)}</button>`).join('');
    }

    el.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-key]');
        if (!btn || btn.dataset.key === cur) return;
        cur = btn.dataset.key;
        draw();
        onChange?.(cur);
    });

    draw();
    return {
        get: () => cur,
        set(key) {
            cur = key;
            draw();
        },
        destroy() {
            el.remove();
        },
    };
}

/* ---------------------------------- 하단 독 ---------------------------------- */

/**
 * 하단 고정 액션 독.
 * 위험 조작(초기화·취소)은 여기 두지 않는다 - `···` 메뉴 + 확인 대화상자로만 처리한다.
 *
 * @param {Element} host 독을 놓을 자리 (독 자체는 화면 하단에 고정된다)
 * @param {object} spec 아래 set() 참고
 * @returns {{el:Element, input:HTMLInputElement, set:Function, value:Function,
 *            clear:Function, focus:Function, destroy:Function}}
 */
export function dock(host, spec = {}) {
    // 독은 화면 하단에 고정되므로 본문이 가리지 않도록 같은 높이의 빈 칸을 남긴다
    const space = document.createElement('div');
    space.className = 'm-dock__space';
    host.appendChild(space);

    const el = document.createElement('div');
    el.className = 'm-dock';
    host.appendChild(el);

    // 입력창은 다시 그려도 같은 노드를 재사용한다 (블루투스 스캐너 연속 입력 시 커서 유지)
    const input = document.createElement('input');
    input.className = 'm-dock__input';
    input.type = 'text';
    input.autocomplete = 'off';
    input.enterKeyHint = 'done';
    input.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        cur.onSubmit?.(input.value.trim());
    });

    let cur = {};

    function button(b, onClick, block = false) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = ['m-btn', 'm-dock__btn', block ? 'm-dock__btn--block' : '',
            TONE[b.tone] ?? ''].filter(Boolean).join(' ');
        btn.disabled = Boolean(b.disabled);
        btn.innerHTML = `${b.icon ? icon(b.icon, 'm-icon') : ''}<span>${esc(b.label)}</span>`;
        btn.addEventListener('click', onClick);
        return btn;
    }

    /**
     * 독의 내용을 바꾼다.
     * @param {{mode?:'input'|'action'|'pair', note?:string,
     *          input?:{placeholder?:string, inputmode?:string},
     *          primary?:object, secondary?:object,
     *          onSubmit?:Function, onPrimary?:Function, onSecondary?:Function}} next
     */
    function set(next = {}) {
        cur = next;
        const mode = next.mode ?? 'input';
        const focused = document.activeElement === input;
        el.className = `m-dock m-dock--${mode}`;
        el.innerHTML = '';

        if (next.note) {
            const note = document.createElement('p');
            note.className = 'm-dock__note';
            note.textContent = next.note;
            el.appendChild(note);
        }

        const row = document.createElement('div');
        row.className = 'm-dock__row';
        el.appendChild(row);

        if (mode === 'input') {
            input.placeholder = next.input?.placeholder ?? '';
            input.inputMode = next.input?.inputmode ?? 'text';
            row.appendChild(input);
            if (next.primary) row.appendChild(button(next.primary, () => next.onPrimary?.()));
        } else if (mode === 'action') {
            row.appendChild(button(next.primary, () => next.onPrimary?.(), true));
        } else {
            if (next.secondary) row.appendChild(button(next.secondary, () => next.onSecondary?.()));
            if (next.primary) row.appendChild(button(next.primary, () => next.onPrimary?.(), true));
        }

        // 다시 그리기 전에 커서가 입력창에 있었으면 되돌린다 (연속 스캔이 끊기지 않게)
        if (focused && row.contains(input)) input.focus();
    }

    set(spec);
    return {
        el,
        input,
        set,
        value: () => input.value.trim(),
        clear() {
            input.value = '';
        },
        focus() {
            input.focus();
            input.select();
        },
        destroy() {
            el.remove();
            space.remove();
        },
    };
}

/* --------------------------------- 바텀시트 --------------------------------- */

/**
 * 바텀시트 (모바일용 모달). util.openModal 과 같은 형태를 돌려준다.
 * @returns {{root:Element, body:Element, foot:Element|null, close:Function}}
 */
export function sheet(title, html, { footer = '', dismissible = true } = {}) {
    const back = document.createElement('div');
    back.className = 'm-sheet-back';
    back.innerHTML = `
<div class="m-sheet" role="dialog" aria-modal="true">
  <div class="m-sheet__top">
    <span class="m-sheet__grip"></span>
    <div class="m-sheet__head">
      <h3>${esc(title)}</h3>
      <button class="m-sheet__close" type="button" aria-label="닫기">
        ${icon('close', 'm-icon')}</button>
    </div>
  </div>
  <div class="m-sheet__body">${html}</div>
  ${footer ? `<div class="m-sheet__foot">${footer}</div>` : ''}
</div>`;
    document.body.appendChild(back);

    const panel = back.querySelector('.m-sheet');
    const close = () => back.remove();
    back.querySelector('.m-sheet__close').addEventListener('click', close);

    if (dismissible) {
        back.addEventListener('click', (e) => {
            if (e.target === back) close();
        });
        // 손잡이를 아래로 밀어 닫는다 (본문 스크롤을 막지 않도록 상단에만 건다)
        const top = back.querySelector('.m-sheet__top');
        let from = null;
        let moved = 0;
        top.addEventListener('touchstart', (e) => {
            from = e.touches[0].clientY;
            moved = 0;
        });
        top.addEventListener('touchmove', (e) => {
            if (from === null) return;
            moved = Math.max(0, e.touches[0].clientY - from);
            panel.style.transform = `translateY(${moved}px)`;
        });
        top.addEventListener('touchend', () => {
            panel.style.transform = '';
            from = null;
            if (moved > 90) close();
        });
    }

    return {
        root: back,
        body: back.querySelector('.m-sheet__body'),
        foot: back.querySelector('.m-sheet__foot'),
        close,
    };
}

/**
 * `···` 메뉴 - 위험 조작(검수 초기화 · 상차완료 취소 · 적치취소)을 담는다.
 * @param {Array<{label:string, icon?:string, tone?:string, onPick:Function}>} items
 */
export function menuSheet(items, title = '작업') {
    const html = `<div class="m-menu">${items.map((it, i) => `
<button class="m-menu__item ${it.tone === 'danger' ? 'is-danger' : ''}" type="button"
        data-i="${i}">${it.icon ? icon(it.icon, 'm-icon') : ''}
  <span>${esc(it.label)}</span></button>`).join('')}</div>`;
    const s = sheet(title, html);
    s.body.querySelectorAll('[data-i]').forEach((el) => {
        el.addEventListener('click', () => {
            s.close();
            items[Number(el.dataset.i)].onPick?.();
        });
    });
    return s;
}

/* ---------------------------------- 숫자 자판 ---------------------------------- */

const KEYPAD_KEYS = ['7', '8', '9', '4', '5', '6', '1', '2', '3', 'C', '0', '←'];

/**
 * 계산기 배열 숫자 자판. 장갑을 낀 손으로 로케이션·수량을 넣을 때 쓴다 (2단계).
 * @param {Element} host 그릴 자리
 * @param {{target:HTMLInputElement}} opt 값을 넣을 입력창
 */
export function keypad(host, { target }) {
    const el = document.createElement('div');
    el.className = 'm-keypad';
    el.hidden = true;
    el.innerHTML = KEYPAD_KEYS.map((k) => `
<button class="m-keypad__key" type="button" data-k="${k}">${k}</button>`).join('');
    host.appendChild(el);

    el.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-k]');
        if (!btn) return;
        const k = btn.dataset.k;
        if (k === 'C') target.value = '';
        else if (k === '←') target.value = target.value.slice(0, -1);
        else target.value += k;
        target.dispatchEvent(new Event('input', { bubbles: true }));
    });

    return {
        toggle(on = el.hidden) {
            el.hidden = !on;
            return !el.hidden;
        },
        destroy() {
            el.remove();
        },
    };
}

/* ---------------------------------- 스캔 바 ---------------------------------- */

/**
 * 바코드 스캔 바 - 카메라 프리뷰(host) + 직접 입력 독(dockHost).
 *
 * 카메라를 못 쓰는 기기(iOS 등 · http 접속)에서는 카메라 버튼을 감추고 안내를 띄운다.
 * **직접 입력만으로도 전량 처리할 수 있어야 한다** - 이 경로는 절대 없애지 않는다.
 *
 * @param {Element} host 프리뷰를 그릴 자리 (독 바로 위)
 * @param {{dockHost?:Element, placeholder?:string, autoFocus?:boolean, camera?:boolean,
 *          keepFocus?:boolean, onSubmit?:(code:string)=>Promise,
 *          onCamera?:(on:boolean)=>void}} opt
 * @returns {{dock:object, start:Function, stop:Function, isOn:Function,
 *            supported:boolean, focus:Function, destroy:Function}}
 */
export function scanBar(host, {
    dockHost = host,
    placeholder = '바코드 직접 입력',
    autoFocus = false,
    camera = true,
    keepFocus = true,
    onSubmit,
    onCamera,
} = {}) {
    const box = document.createElement('div');
    box.className = 'm-scanbox';
    box.hidden = true;
    box.innerHTML = `
<video class="m-scanbox__video" playsinline muted></video>
<span class="m-scanbox__aim"></span>`;
    host.appendChild(box);

    const useCam = camera && scanSupported();
    const scanner = useCam
        ? createScanner(box.querySelector('video'), (code) => handle(code))
        : null;

    // 처리 중에 다음 코드가 들어오면 순서가 뒤엉킨다 (블루투스 스캐너는 매우 빠르다)
    let busy = false;

    async function handle(code) {
        const v = String(code ?? '').trim();
        if (!v || busy) return;
        busy = true;
        try {
            await onSubmit?.(v);
        } finally {
            busy = false;
        }
    }

    function spec() {
        const camBtn = scanner?.isOn()
            ? { label: '중지', icon: 'stop', tone: 'danger' }
            : { label: '카메라', icon: 'camera', tone: 'primary' };
        return {
            mode: 'input',
            note: useCam ? '' : '이 기기·접속에서는 카메라를 쓸 수 없습니다.'
                + ' 바코드를 직접 입력하거나 블루투스 스캐너로 스캔하세요.',
            input: { placeholder },
            primary: useCam ? camBtn : null,
            onPrimary: () => (scanner?.isOn() ? stop() : start()),
            onSubmit: manual,
        };
    }

    async function manual(value) {
        if (!value) {
            d.focus();
            return;
        }
        d.clear();          // 다음 코드가 이어붙지 않게 먼저 비운다
        await handle(value);
        if (keepFocus) d.focus();
    }

    async function start() {
        if (!scanner) return;
        try {
            await scanner.start();
            box.hidden = false;
        } catch (err) {
            toast(err.message, 'error');
        }
        d.set(spec());
        onCamera?.(Boolean(scanner.isOn()));
    }

    function stop() {
        const was = Boolean(scanner?.isOn());
        scanner?.stop();
        box.hidden = true;
        d.set(spec());
        if (was) onCamera?.(false);
    }

    const d = dock(dockHost, spec());
    if (autoFocus) d.focus();

    return {
        dock: d,
        start,
        stop,
        isOn: () => Boolean(scanner?.isOn()),
        supported: useCam,
        focus: () => d.focus(),
        /** 독을 다시 스캔 모드로 되돌린다 (상차완료 버튼 등으로 바꿔 놓았을 때) */
        resetDock: () => d.set(spec()),
        destroy() {
            stop();
            d.destroy();
            box.remove();
        },
    };
}
