/**
 * Code128 바코드 생성 (외부 라이브러리 없이 SVG 로 그린다).
 * 테스트용 바코드 시트와 현장 라벨 출력에 쓴다.
 * Code Set B 만 사용하므로 영문 대소문자·숫자·기호(ASCII 32~126)를 모두 담을 수 있다.
 */

/** Code128 심볼 패턴 (인덱스 0~106). 각 자리는 바/공백의 굵기다. */
const PATTERNS = [
    '212222', '222122', '222221', '121223', '121322', '131222', '122213', '122312',
    '132212', '221213', '221312', '231212', '112232', '122132', '122231', '113222',
    '123122', '123221', '223211', '221132', '221231', '213212', '223112', '312131',
    '311222', '321122', '321221', '312212', '322112', '322211', '212123', '212321',
    '232121', '111323', '131123', '131321', '112313', '132113', '132311', '211313',
    '231113', '231311', '112133', '112331', '132131', '113123', '113321', '133121',
    '313121', '211331', '231131', '213113', '213311', '213131', '311123', '311321',
    '331121', '312113', '312311', '332111', '314111', '221411', '431111', '111224',
    '111422', '121124', '121421', '141122', '141221', '112214', '112412', '122114',
    '122411', '142112', '142211', '241211', '221114', '413111', '241112', '134111',
    '111242', '121142', '121241', '114212', '124112', '124211', '411212', '421112',
    '421211', '212141', '214121', '412121', '111143', '111341', '131141', '114113',
    '114311', '411113', '411311', '113141', '114131', '311141', '411131', '211412',
    '211214', '211232', '2331112',
];

const START_B = 104;
const STOP = 106;

/**
 * 문자열을 Code128-B 심볼 인덱스 배열로 바꾼다 (체크섬·스톱 포함).
 * @param {string} text 인코딩할 문자열
 */
function encode(text) {
    const codes = [START_B];
    let sum = START_B;
    [...text].forEach((ch, i) => {
        const v = ch.charCodeAt(0) - 32;
        if (v < 0 || v > 94) throw new Error(`Code128-B 로 표현할 수 없는 문자: ${ch}`);
        codes.push(v);
        sum += v * (i + 1);
    });
    codes.push(sum % 103);   // 체크섬
    codes.push(STOP);
    return codes;
}

/**
 * Code128 바코드를 SVG 문자열로 만든다.
 * @param {string} text 인코딩할 문자열
 * @param {{height?:number, moduleWidth?:number, showText?:boolean}} opt
 */
export function code128Svg(text, opt = {}) {
    const height = opt.height ?? 70;
    const mw = opt.moduleWidth ?? 2;      // 최소 모듈 굵기(px)
    const showText = opt.showText ?? true;
    const quiet = 10 * mw;                 // 좌우 여백 (스캔 성공률을 위해 필요)
    const textH = showText ? 18 : 0;

    let x = quiet;
    let bars = '';
    encode(text).forEach((code) => {
        let isBar = true;
        [...PATTERNS[code]].forEach((n) => {
            const w = Number(n) * mw;
            if (isBar) bars += `<rect x="${x}" y="0" width="${w}" height="${height}"/>`;
            x += w;
            isBar = !isBar;
        });
    });

    const total = x + quiet;
    const label = showText
        ? `<text x="${total / 2}" y="${height + 14}" text-anchor="middle"
             font-family="monospace" font-size="13" fill="#000">${text}</text>`
        : '';

    return `
<svg xmlns="http://www.w3.org/2000/svg" width="${total}" height="${height + textH}"
     viewBox="0 0 ${total} ${height + textH}" role="img" aria-label="${text}">
  <rect width="${total}" height="${height + textH}" fill="#fff"/>
  <g fill="#000">${bars}</g>
  ${label}
</svg>`;
}
