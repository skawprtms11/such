/**
 * 검수 화면 - 모바일 카메라로 상차라벨의 주문번호 바코드를 스캔한다.
 * 라벨은 파렛트마다 붙어 있고 모두 같은 주문번호라, 한 번 스캔할 때마다
 * 파렛트 1개가 검수된다 (주문처리현황에서 출력한 라벨을 쓴다).
 * 스캔은 scanner.js 공통 모듈을 쓴다 (iOS 등 내장 인식기가 없는 기기도 지원).
 */
import { LOAD_STATUS } from '../config.js';
import { can } from '../auth.js';
import * as db from '../db.js';
import { createScanner, scanSupported } from '../scanner.js';
import { icon } from '../icons.js';
import { esc, num, rate, toast, confirmDialog, seqTag } from '../util.js';

export async function render(root, { user, params }) {
    const orderId = params[0];
    const order = await db.getOrder(orderId);
    if (!order) {
        root.innerHTML = '<div class="empty">주문을 찾을 수 없습니다.</div>';
        return null;
    }
    const editable = can(user, 'updateStatus');

    root.innerHTML = `
<button class="btn btn--sm" id="btn-back" type="button" style="margin-bottom:12px">
  ← 상차리스트로
</button>

<div class="scan-head" id="scan-head"></div>

<div class="card">
  <div class="card__head">
    <h2>바코드 검수</h2>
    <div class="toolbar__spacer"></div>
    ${editable ? '<button class="btn btn--sm" id="btn-reset" type="button">검수 초기화</button>' : ''}
  </div>
  <div class="card__body">
    ${editable ? `
    <p class="form-note" style="margin:0 0 12px">
      파렛트에 붙은 <b>상차라벨의 주문번호 바코드</b>를 파렛트마다 한 번씩 스캔합니다.
      (같은 라벨을 연속으로 읽는 것을 막기 위해 카메라는 2.5초 간격으로 인식합니다)
    </p>
    <div class="btn-row" style="margin-bottom:12px">
      <button class="btn btn--primary" id="btn-cam" type="button">
        ${icon('camera')} 카메라 스캔 시작</button>
    </div>
    <div id="cam-note"></div>
    <video id="scan-video" playsinline muted hidden></video>
    <div class="toolbar" style="margin-top:12px">
      <label class="field" style="flex:1">
        <span class="field__label">바코드 직접 입력</span>
        <input type="text" id="manual" placeholder="${esc(order.order_no)}"
               autocomplete="off" enterkeyhint="done">
      </label>
      <button class="btn" id="btn-manual" type="button">검수 등록</button>
    </div>` : '<p class="field__label">검수 권한이 없어 조회만 가능합니다.</p>'}

    <div class="pallet-list" id="pallets"></div>

    ${editable ? `
    <button class="btn btn--success btn--lg btn--block" id="btn-load" type="button"
            style="margin-top:16px" hidden>상차완료 처리</button>` : ''}
  </div>
</div>`;

    root.querySelector('#btn-back').addEventListener('click', () => {
        location.hash = '#/loading';
    });

    // 바코드 스캔은 공통 모듈을 쓴다 (iOS 등 내장 인식기가 없는 기기도 지원)
    const scanner = createScanner(root.querySelector('#scan-video'), (code) => submit(code));

    /** 카메라 버튼 표시를 현재 상태에 맞춘다 */
    function syncCamBtn() {
        const btn = root.querySelector('#btn-cam');
        if (!btn) return;
        btn.innerHTML = scanner.isOn()
            ? `${icon('stop')} 스캔 중지` : `${icon('camera')} 카메라 스캔 시작`;
        btn.classList.toggle('btn--danger', scanner.isOn());
        btn.classList.toggle('btn--primary', !scanner.isOn());
    }

    function stopCamera() {
        scanner.stop();
        syncCamBtn();
    }

    /** 직접 입력으로 처리하는 동안에는 목록을 다시 그려도 커서를 유지한다 */
    let keepFocus = false;

    /** 헤더 요약과 파렛트 목록을 다시 그린다 */
    async function refresh() {
        // 추가주문은 1차수와 함께 실리므로 같은 주문번호의 모든 차수를 한 번에 검수한다
        const g = await db.getLoadGroup(orderId);
        const o = g.head;
        const pallets = g.pallets;
        const done = pallets.filter((p) => p.scanned_at).length;
        const pct = rate(done, pallets.length);

        root.querySelector('#scan-head').innerHTML = `
<h2>${esc(o.order_no)} <span class="tag tag--blue">${g.rows.length}개 차수</span></h2>
<p>${esc(o.customer)} · ${esc(o.vehicle_type)} · 출고 ${o.ship_req_date}</p>
${g.rows.length > 1 ? `
<p class="field__label">추가주문 ${g.rows.length - 1}건이 함께 검수됩니다.</p>` : ''}
<div class="scan-stats">
  <div><span>총 파렛트</span><strong>${num(pallets.length)}</strong></div>
  <div><span>검수 파렛트</span><strong>${num(done)}</strong></div>
  <div><span>진행률</span><strong>${pct}%</strong></div>
</div>
<div class="bar" style="margin-top:10px">
  <div class="bar__fill ${pct === 100 ? 'bar__fill--done' : ''}" style="width:${pct}%"></div>
</div>`;

        // 라벨 바코드가 모두 같은 주문번호라 순번으로 보여준다 (라벨 우측 하단 연번과 같은 순서)
        root.querySelector('#pallets').innerHTML = pallets.length ? pallets.map((p, i) => `
<div class="pallet ${p.scanned_at ? 'is-scanned' : ''}">
  <span class="pallet__mark">${icon(p.scanned_at ? 'check' : 'square')}</span>
  ${seqTag(p.seq, '차')}
  <span class="pallet__code" title="${esc(p.barcode)}">
    파렛트 ${i + 1} <small>/ ${pallets.length}</small>
  </span>
  <span class="tag ${p.scanned_at ? 'tag--green' : 'tag--gray'}">
    ${p.scanned_at ? '검수완료' : '대기'}
  </span>
</div>`).join('') : '<div class="empty">등록된 파렛트가 없습니다. 주문의 파렛트수를 입력하세요.</div>';

        const loadBtn = root.querySelector('#btn-load');
        // 차수 전체가 검수돼야 상차완료할 수 있다
        const allInspected = g.rows.every((r) => r.load_status === LOAD_STATUS.INSPECTED);
        if (loadBtn) loadBtn.hidden = !allInspected;
        if (done >= pallets.length) stopCamera();
        // 스캐너로 연속 입력하는 중이면 커서를 입력창에 남겨 둔다
        if (keepFocus) root.querySelector('#manual')?.focus();
        return { order: o, total: pallets.length, done };
    }

    /** 바코드 1건 처리 */
    async function submit(code) {
        if (!code) return;
        const res = await db.scanPallet(orderId, code, user);
        toast(res.msg, res.ok ? 'success' : 'error');
        if (res.ok && navigator.vibrate) navigator.vibrate(60);
        const { total, done } = await refresh();
        if (res.ok && done >= total) {
            stopCamera();
            toast('모든 파렛트 검수가 완료되었습니다.', 'success');
        }
    }

    if (editable && !scanSupported()) {
        root.querySelector('#btn-cam').hidden = true;
        root.querySelector('#cam-note').innerHTML = `
<p class="form-note">
  ⚠️ 이 접속에서는 카메라를 쓸 수 없습니다.
  카메라는 <b>HTTPS 또는 localhost</b> 에서만 동작합니다
  (<code>npm run dev:https</code> 로 띄운 주소로 접속하세요).
  아래 <b>바코드 직접 입력</b> 으로도 검수할 수 있고, 블루투스 스캐너도 그대로 됩니다.
</p>`;
    }

    if (editable) {
        const manual = root.querySelector('#manual');
        /**
         * 직접 입력 처리.
         * 블루투스 스캐너는 코드를 타이핑하고 Enter 를 보내는 방식이라,
         * 처리 후 **입력창을 비우고 포커스를 되돌려야** 연속으로 스캔할 수 있다.
         */
        const doManual = async () => {
            const code = manual.value.trim();
            if (!code) {
                manual.focus();
                return;
            }
            manual.value = '';
            keepFocus = true;
            await submit(code);
            keepFocus = false;
            manual.focus();
            manual.select();
        };
        root.querySelector('#btn-manual').addEventListener('click', doManual);
        manual.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); doManual(); }
        });

        root.querySelector('#btn-cam').addEventListener('click', async () => {
            if (scanner.isOn()) {
                scanner.stop();
                syncCamBtn();
                return;
            }
            try {
                await scanner.start();
            } catch (err) {
                toast(err.message, 'error');
            }
            syncCamBtn();
        });

        root.querySelector('#btn-reset').addEventListener('click', async () => {
            if (!await confirmDialog('검수 내역을 모두 초기화하시겠습니까?')) return;
            await db.resetInspection(orderId, user);
            toast('검수가 초기화되었습니다.');
            refresh();
        });

        root.querySelector('#btn-load').addEventListener('click', async () => {
            if (!await confirmDialog('상차완료 처리하시겠습니까?')) return;
            try {
                await db.completeLoading(orderId, user);
                toast('상차완료 처리되었습니다.', 'success');
                location.hash = '#/loading';
            } catch (err) {
                toast(err.message, 'error');
            }
        });
    }

    await refresh();
    const unsubscribe = db.subscribe(refresh, 8000);
    return () => {
        stopCamera();
        unsubscribe();
    };
}
