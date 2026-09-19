/**
 * QR 코드 생성 (외부 라이브러리 없이 SVG 로 그린다).
 *
 * 🔑 **1D 바코드와 짝을 이루는 하이브리드 라벨용이다.** 같은 문자열을 Code128 과 QR 로
 * 나란히 인쇄해, 휴대폰 카메라는 QR 을 · 1D 전용 하드웨어 스캐너는 Code128 을 읽는다
 * ([docs/status.md](../../docs/status.md) 「상차라벨 출력」 참고).
 *
 * 범위를 일부러 좁혔다 - **바이트 모드(UTF-8) · 오류정정 M · 버전 1~10** 뿐이다.
 * 우리가 찍는 값은 주문번호·대표주문번호·유통가공 문서번호(길어야 40자 남짓)라
 * 이 범위를 넘지 않는다. `code128Svg` 와 같이 의존성 0 으로 두려고 직접 구현했다.
 */
import { esc } from './util.js';

/* ------------------------------ 규격 표 (버전 1~10 · 레벨 M) ------------------------------ */

/**
 * 레벨 M 의 블록 구성 - `[블록당 오류정정 코드워드, [블록수, 블록당 데이터 코드워드], ...]`.
 * 8·9·10 버전은 데이터 길이가 다른 블록이 섞인다 (QR 규격 표 그대로다).
 */
const EC_BLOCKS = [
    [10, [1, 16]],
    [16, [1, 28]],
    [26, [1, 44]],
    [18, [2, 32]],
    [24, [2, 43]],
    [16, [4, 27]],
    [18, [4, 31]],
    [22, [2, 38], [2, 39]],
    [22, [3, 36], [2, 37]],
    [26, [4, 43], [1, 44]],
];

/** 버전별 정렬 패턴 중심 좌표 (버전 1은 없다) */
const ALIGN_POS = [
    [], [6, 18], [6, 22], [6, 26], [6, 30],
    [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50],
];

/** 이 모듈이 다루는 최대 버전 */
const MAX_VERSION = EC_BLOCKS.length;

/* ---------------------------------- GF(256) 산술 ---------------------------------- */

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(() => {
    let x = 1;
    for (let i = 0; i < 255; i += 1) {
        EXP[i] = x;
        LOG[x] = i;
        x <<= 1;
        if (x & 0x100) x ^= 0x11d;      // 원시 다항식 x^8+x^4+x^3+x^2+1
    }
    for (let i = 255; i < 512; i += 1) EXP[i] = EXP[i - 255];
})();

/** GF(256) 곱셈 */
function gmul(a, b) {
    return a && b ? EXP[LOG[a] + LOG[b]] : 0;
}

/** 차수 `n` 의 생성 다항식 (계수 배열, 최고차부터) */
function rsGenerator(n) {
    let poly = [1];
    for (let i = 0; i < n; i += 1) {
        const next = new Array(poly.length + 1).fill(0);
        poly.forEach((c, j) => {
            next[j] ^= c;
            next[j + 1] ^= gmul(c, EXP[i]);
        });
        poly = next;
    }
    return poly;
}

/**
 * 리드-솔로몬 오류정정 코드워드를 만든다.
 * @param {number[]} data 데이터 코드워드
 * @param {number} n 만들 오류정정 코드워드 수
 */
function rsEncode(data, n) {
    const gen = rsGenerator(n);
    const rem = new Array(n).fill(0);
    data.forEach((b) => {
        const factor = b ^ rem[0];
        rem.shift();
        rem.push(0);
        gen.slice(1).forEach((g, i) => { rem[i] ^= gmul(g, factor); });
    });
    return rem;
}

/* ---------------------------------- 데이터 인코딩 ---------------------------------- */

/** 버전의 데이터 코드워드 총수 */
function dataCount(version) {
    return EC_BLOCKS[version - 1].slice(1).reduce((sum, [n, len]) => sum + n * len, 0);
}

/** 바이트 모드 글자수 필드의 비트 수 (버전 10부터 16비트다) */
function lenBits(version) {
    return version < 10 ? 8 : 16;
}

/** 바이트 길이를 담을 수 있는 가장 작은 버전 */
function pickVersion(byteLen) {
    for (let v = 1; v <= MAX_VERSION; v += 1) {
        const cap = dataCount(v) * 8 - 4 - lenBits(v);
        if (byteLen * 8 <= cap) return v;
    }
    throw new Error(`QR 로 담기에 너무 긴 값입니다 (${byteLen} 바이트 · 버전 ${MAX_VERSION} 한계)`);
}

/**
 * 바이트 배열을 그 버전의 데이터 코드워드로 만든다 (모드·글자수·종단자·패딩까지).
 * @param {Uint8Array} bytes UTF-8 바이트
 * @param {number} version QR 버전
 */
function dataCodewords(bytes, version) {
    const bits = [];
    const push = (value, n) => {
        for (let i = n - 1; i >= 0; i -= 1) bits.push((value >> i) & 1);
    };
    push(0b0100, 4);                       // 바이트 모드
    push(bytes.length, lenBits(version));
    bytes.forEach((b) => push(b, 8));

    const total = dataCount(version) * 8;
    for (let i = 0; i < 4 && bits.length < total; i += 1) bits.push(0);   // 종단자
    while (bits.length % 8) bits.push(0);

    const cw = [];
    for (let i = 0; i < bits.length; i += 8) {
        cw.push(bits.slice(i, i + 8).reduce((v, b) => (v << 1) | b, 0));
    }
    // 남는 자리는 0xEC · 0x11 을 번갈아 채운다 (규격이 정한 패딩 값 · 항상 0xEC 로 시작한다)
    const need = dataCount(version);
    for (let i = 0; cw.length < need; i += 1) cw.push(i % 2 ? 0x11 : 0xec);
    return cw;
}

/**
 * 블록별로 오류정정을 붙이고 규격대로 교차 배치한 최종 코드워드 열.
 * @param {number[]} data 데이터 코드워드
 * @param {number} version QR 버전
 */
function interleave(data, version) {
    const [ecPer, ...groups] = EC_BLOCKS[version - 1];
    const blocks = [];
    let at = 0;
    groups.forEach(([count, len]) => {
        for (let i = 0; i < count; i += 1) {
            const d = data.slice(at, at + len);
            at += len;
            blocks.push({ d, e: rsEncode(d, ecPer) });
        }
    });
    const out = [];
    const maxLen = Math.max(...blocks.map((b) => b.d.length));
    for (let i = 0; i < maxLen; i += 1) {
        blocks.forEach((b) => { if (i < b.d.length) out.push(b.d[i]); });
    }
    for (let i = 0; i < ecPer; i += 1) blocks.forEach((b) => out.push(b.e[i]));
    return out;
}

/* ---------------------------------- 모듈 배치 ---------------------------------- */

/** BCH(15,5) 로 계산한 포맷 정보 15비트. 레벨 M 은 지시자가 `0b00` 이라 마스크 번호가 곧 데이터다 */
function formatBits(mask) {
    const data = (0b00 << 3) | mask;
    let d = data << 10;
    for (let i = 4; i >= 0; i -= 1) if ((d >> (10 + i)) & 1) d ^= 0x537 << i;
    return ((data << 10) | d) ^ 0x5412;
}

/** BCH(18,6) 로 계산한 버전 정보 18비트 (버전 7 이상에만 넣는다) */
function versionBits(version) {
    let d = version << 12;
    for (let i = 5; i >= 0; i -= 1) if ((d >> (12 + i)) & 1) d ^= 0x1f25 << i;
    return (version << 12) | d;
}

/** 기능 패턴(파인더·분리자·타이밍·정렬·예약칸)을 채운 빈 행렬을 만든다 */
function baseMatrix(version) {
    const size = version * 4 + 17;
    const m = Array.from({ length: size }, () => new Array(size).fill(0));
    const fixed = Array.from({ length: size }, () => new Array(size).fill(false));
    const put = (r, c, v) => {
        if (r < 0 || c < 0 || r >= size || c >= size) return;
        m[r][c] = v;
        fixed[r][c] = true;
    };

    // 파인더 3개 + 분리자
    [[0, 0], [0, size - 7], [size - 7, 0]].forEach(([r0, c0]) => {
        for (let r = -1; r <= 7; r += 1) {
            for (let c = -1; c <= 7; c += 1) {
                const on = r >= 0 && r <= 6 && c >= 0 && c <= 6
                    && (r === 0 || r === 6 || c === 0 || c === 6
                        || (r >= 2 && r <= 4 && c >= 2 && c <= 4));
                put(r0 + r, c0 + c, on ? 1 : 0);
            }
        }
    });

    // 타이밍 패턴 (6행 · 6열)
    for (let i = 8; i < size - 8; i += 1) {
        const on = i % 2 === 0 ? 1 : 0;
        put(6, i, on);
        put(i, 6, on);
    }

    // 정렬 패턴 - 파인더와 겹치는 자리는 건너뛴다
    const pos = ALIGN_POS[version - 1];
    pos.forEach((r0) => pos.forEach((c0) => {
        const corner = (r0 <= 8 && c0 <= 8)
            || (r0 <= 8 && c0 >= size - 9) || (r0 >= size - 9 && c0 <= 8);
        if (corner) return;
        for (let r = -2; r <= 2; r += 1) {
            for (let c = -2; c <= 2; c += 1) {
                const on = Math.max(Math.abs(r), Math.abs(c)) !== 1 ? 1 : 0;
                put(r0 + r, c0 + c, on);
            }
        }
    }));

    // 포맷 정보 자리를 미리 막아 둔다 (값은 마스크가 정해진 뒤 쓴다).
    // ⚠️ 8행 6열·6행 8열은 포맷이 아니라 **타이밍**이다 - 건드리면 인식기가 격자를 못 잡는다
    for (let i = 0; i <= 8; i += 1) {
        if (i === 6) continue;
        put(8, i, 0);
        put(i, 8, 0);
    }
    for (let i = 0; i <= 7; i += 1) put(8, size - 1 - i, 0);
    for (let i = 0; i <= 6; i += 1) put(size - 1 - i, 8, 0);
    put(size - 8, 8, 1);                   // 고정 어두운 모듈 (포맷 자리 다음에 찍는다)

    if (version >= 7) {
        const bits = versionBits(version);
        for (let i = 0; i < 18; i += 1) {
            const on = (bits >> i) & 1;
            put(Math.floor(i / 3), size - 11 + (i % 3), on);
            put(size - 11 + (i % 3), Math.floor(i / 3), on);
        }
    }
    return { m, fixed, size };
}

/** 코드워드 열을 지그재그로 채워 넣는다 (오른쪽 아래에서 위로, 2열씩) */
function placeData(m, fixed, size, codewords) {
    let bit = 0;
    const next = () => {
        const byte = codewords[bit >> 3];
        const on = byte === undefined ? 0 : (byte >> (7 - (bit & 7))) & 1;
        bit += 1;
        return on;
    };
    let up = true;
    let col = size - 1;
    while (col > 0) {
        if (col === 6) col -= 1;            // 세로 타이밍 열은 통째로 건너뛴다
        for (let i = 0; i < size; i += 1) {
            const row = up ? size - 1 - i : i;
            for (let k = 0; k < 2; k += 1) {
                const c = col - k;
                if (!fixed[row][c]) m[row][c] = next();
            }
        }
        up = !up;
        col -= 2;
    }
}

/** 마스크 8종 - 좌표가 조건에 맞는 칸의 색을 뒤집는다 */
const MASKS = [
    (r, c) => (r + c) % 2 === 0,
    (r) => r % 2 === 0,
    (_r, c) => c % 3 === 0,
    (r, c) => (r + c) % 3 === 0,
    (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
    (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
    (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
    (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

/**
 * 포맷 정보 15비트를 두 곳(좌상단 · 우상단+좌하단)에 쓴다.
 * 🔑 두 사본은 **읽는 방향이 서로 반대**다 - 첫 사본은 낮은 비트가 세로(8열)에,
 * 두 번째 사본은 낮은 비트가 가로(8행 오른쪽)에 온다. 뒤집으면 인식기가 마스크를 잘못 읽는다.
 */
function writeFormat(m, size, mask) {
    const bits = formatBits(mask);
    const on = (i) => (bits >> i) & 1;
    for (let i = 0; i <= 5; i += 1) m[i][8] = on(i);
    m[7][8] = on(6);
    m[8][8] = on(7);
    m[8][7] = on(8);
    for (let i = 9; i <= 14; i += 1) m[8][14 - i] = on(i);
    // 두 번째 사본 - 가로 8칸(비트 0~7) + 세로 7칸(비트 8~14). 고정 어두운 모듈 자리는 비켜 간다
    for (let i = 0; i <= 7; i += 1) m[8][size - 1 - i] = on(i);
    for (let i = 8; i <= 14; i += 1) m[size - 15 + i][8] = on(i);
}

/** 한 줄(행 또는 열)에서 같은 색이 5칸 이상 이어진 벌점 (규칙 1) */
function runPenalty(line) {
    let score = 0;
    let run = 1;
    for (let i = 1; i < line.length; i += 1) {
        if (line[i] === line[i - 1]) {
            run += 1;
            if (run === 5) score += 3;
            else if (run > 5) score += 1;
        } else run = 1;
    }
    return score;
}

/** 파인더를 닮은 배열 - 규칙 3 이 찾는 두 가지 형태 */
const FINDER_LIKE = [
    [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0],
    [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1],
];

/** 한 줄에서 파인더 닮은꼴이 나온 횟수 (규칙 3) */
function finderPenalty(line) {
    let score = 0;
    for (let i = 0; i + 11 <= line.length; i += 1) {
        FINDER_LIKE.forEach((pat) => {
            if (pat.every((v, k) => line[i + k] === v)) score += 40;
        });
    }
    return score;
}

/** 마스크 벌점 (규격의 규칙 1~4 · 낮을수록 좋다) */
function penalty(m, size) {
    let score = 0;
    let dark = 0;
    for (let r = 0; r < size; r += 1) {
        const row = m[r];
        const col = m.map((line) => line[r]);
        score += runPenalty(row) + runPenalty(col);
        score += finderPenalty(row) + finderPenalty(col);
        row.forEach((v) => { dark += v; });
    }
    for (let r = 0; r < size - 1; r += 1) {
        for (let c = 0; c < size - 1; c += 1) {
            const v = m[r][c];
            if (v === m[r][c + 1] && v === m[r + 1][c] && v === m[r + 1][c + 1]) score += 3;
        }
    }
    const ratio = (dark * 100) / (size * size);
    score += Math.floor(Math.abs(ratio - 50) / 5) * 10;
    return score;
}

/**
 * 문자열을 QR 모듈 행렬(0/1)로 만든다. 마스크 8종을 모두 평가해 벌점이 가장 낮은 것을 쓴다.
 * @param {string} text 인코딩할 문자열
 * @returns {number[][]} `[행][열]` = 1 이면 어두운 모듈
 */
export function qrMatrix(text) {
    const bytes = new TextEncoder().encode(String(text ?? ''));
    const version = pickVersion(bytes.length);
    const codewords = interleave(dataCodewords(bytes, version), version);

    let best = null;
    for (let mask = 0; mask < MASKS.length; mask += 1) {
        const { m, fixed, size } = baseMatrix(version);
        placeData(m, fixed, size, codewords);
        for (let r = 0; r < size; r += 1) {
            for (let c = 0; c < size; c += 1) {
                if (!fixed[r][c] && MASKS[mask](r, c)) m[r][c] ^= 1;
            }
        }
        writeFormat(m, size, mask);
        const score = penalty(m, size);
        if (!best || score < best.score) best = { score, m };
    }
    return best.m;
}

/**
 * QR 코드를 SVG 문자열로 만든다.
 *
 * `viewBox` 는 모듈 단위라 호출부에서 `width/height` 만 CSS 로 잡으면 어떤 크기로도 늘어난다.
 * ⚠️ **가로세로 비율을 깨지 말 것** - 1D 바코드와 달리 QR 은 정사각형이어야 읽힌다.
 * @param {string} text 인코딩할 문자열
 * @param {{module?:number, quiet?:number}} opt `module` = 모듈 한 변(px) ·
 *        `quiet` = 둘레 여백(모듈 수 · 규격 최소 4)
 */
export function qrSvg(text, opt = {}) {
    const m = qrMatrix(text);
    const size = m.length;
    const quiet = Math.max(0, opt.quiet ?? 4);
    const mod = opt.module ?? 4;
    const span = size + quiet * 2;
    const px = span * mod;

    // 한 행의 연속된 어두운 모듈은 사각형 하나로 합친다 (SVG 가 3~4배 작아진다)
    let rects = '';
    m.forEach((row, r) => {
        let start = -1;
        for (let c = 0; c <= size; c += 1) {
            const on = c < size && row[c] === 1;
            if (on && start < 0) start = c;
            if (!on && start >= 0) {
                rects += `<rect x="${start + quiet}" y="${r + quiet}"`
                    + ` width="${c - start}" height="1"/>`;
                start = -1;
            }
        }
    });

    const safe = esc(String(text ?? ''));
    return `
<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}"
     viewBox="0 0 ${span} ${span}" shape-rendering="crispEdges"
     role="img" aria-label="${safe}">
  <rect width="${span}" height="${span}" fill="#fff"/>
  <g fill="#000">${rects}</g>
</svg>`;
}
