/** ESLint 설정 - 프로젝트 코딩 규칙(4칸 들여쓰기, 100자, 구체적 예외 처리)을 강제한다 */
import globals from 'globals';

export default [
    {
        ignores: ['dist/**', 'node_modules/**', 'dev-dist/**'],
    },
    {
        files: ['**/*.js'],
        languageOptions: {
            ecmaVersion: 2023,
            sourceType: 'module',
            globals: {
                ...globals.browser,
                ...globals.serviceworker,
            },
        },
        rules: {
            indent: ['error', 4, { SwitchCase: 1 }],
            'max-len': ['warn', { code: 100, ignoreUrls: true, ignoreTemplateLiterals: true }],
            quotes: ['error', 'single', { avoidEscape: true }],
            semi: ['error', 'always'],
            'comma-dangle': ['error', 'always-multiline'],
            'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
            'no-var': 'error',
            'prefer-const': 'error',
            eqeqeq: ['error', 'always', { null: 'ignore' }],
            'no-console': ['warn', { allow: ['warn', 'error'] }],
            'object-curly-spacing': ['error', 'always'],
            'arrow-parens': ['error', 'always'],
        },
    },
    {
        // 빌드 설정 파일은 Node 환경에서 실행된다
        files: ['vite.config.js', 'eslint.config.js'],
        languageOptions: {
            globals: globals.node,
        },
    },
];
