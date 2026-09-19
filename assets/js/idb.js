/**
 * IndexedDB 얇은 래퍼 (docs/processing.md §17-4 · A24).
 *
 * 쓰는 곳은 두 군데다.
 *   files  : mock 모드의 **사진 저장소** (store.js 의 putFile/fileUrls)
 *   drafts : 저장 전 촬영분 **초안** (앱 유통가공 검수 화면이 화면을 떠나도 지키는 사진)
 *
 * ⚠️ **사진을 localStorage 에 넣지 않는다.** 압축해도 장당 150~200KB 라 한도(5MB)가 금방 차고,
 * `saveDb` 는 전체 JSON 을 한 번에 쓰므로 사진뿐 아니라 주문·체크리스트 저장까지 막힌다.
 * IndexedDB 는 Blob 을 그대로 담아 base64 로 부풀지도 않는다.
 */

const DB_NAME = 'tpl_files';
const DB_VER = 1;

/** 스토어 이름 - 두 용도를 한 데이터베이스 안에서 나눈다 */
export const STORE = { FILES: 'files', DRAFTS: 'drafts' };

let opening = null;

/** 데이터베이스를 연다 (한 번만 열고 재사용한다) */
function open() {
    if (opening) return opening;
    opening = new Promise((resolve, reject) => {
        // 사파리 프라이빗 모드는 여기서 곧바로 예외를 던지기도 한다 (아래 catch 가 받는다)
        const req = indexedDB.open(DB_NAME, DB_VER);
        req.onupgradeneeded = () => {
            const db = req.result;
            Object.values(STORE).forEach((name) => {
                if (!db.objectStoreNames.contains(name)) db.createObjectStore(name);
            });
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(new Error(`사진 저장소를 열지 못했습니다: ${req.error?.message}`));
    }).catch((err) => {
        // 🔑 실패한 약속을 들고 있으면 한 번 막힌 기기는 **영영** 못 연다. 다음 호출이 다시 연다
        opening = null;
        throw err;
    });
    return opening;
}

/** 트랜잭션 한 건을 약속(Promise)으로 감싼다 */
async function run(store, mode, fn) {
    const db = await open();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(store, mode);
        const req = fn(tx.objectStore(store));
        tx.onerror = () => reject(new Error(`사진 저장소 오류: ${tx.error?.message}`));
        tx.oncomplete = () => resolve(req ? req.result : undefined);
    });
}

/** 값 저장 (같은 키면 덮어쓴다) */
export function idbPut(store, key, value) {
    return run(store, 'readwrite', (os) => os.put(value, key));
}

/** 값 읽기 (없으면 undefined) */
export function idbGet(store, key) {
    return run(store, 'readonly', (os) => os.get(key));
}

/** 값 삭제 */
export function idbDel(store, key) {
    return run(store, 'readwrite', (os) => os.delete(key));
}

/**
 * 스토어를 통째로 비운다 (로그아웃).
 * 🔑 초안·사진은 **다음 사람에게 보여서는 안 되는 현장 증빙**인데 세션 저장소가 아니라
 * IndexedDB 에 있어 로그아웃해도 남는다. 공용 단말에서 다음 사용자가 그대로 본다.
 */
export function idbClear(store) {
    return run(store, 'readwrite', (os) => os.clear());
}

/**
 * 접두사로 시작하는 항목 전부 (초안 복구에 쓴다).
 * @returns {Promise<Array<{key:string, value:*}>>}
 */
export async function idbList(store, prefix = '') {
    const db = await open();
    return new Promise((resolve, reject) => {
        const out = [];
        const tx = db.transaction(store, 'readonly');
        const range = prefix
            ? IDBKeyRange.bound(prefix, `${prefix}￿`, false, false)
            : undefined;
        const req = tx.objectStore(store).openCursor(range);
        req.onsuccess = () => {
            const cur = req.result;
            if (!cur) return;
            out.push({ key: String(cur.key), value: cur.value });
            cur.continue();
        };
        tx.onerror = () => reject(new Error(`사진 저장소 오류: ${tx.error?.message}`));
        tx.oncomplete = () => resolve(out);
    });
}
