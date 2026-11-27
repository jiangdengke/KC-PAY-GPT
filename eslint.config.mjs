import js from '@eslint/js';
import globals from 'globals';

const sharedRules = {
    'no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_'
    }],
    'no-constant-condition': ['error', { checkLoops: false }],
    'no-empty': ['error', { allowEmptyCatch: true }],
    'no-var': 'error',
    'prefer-const': ['error', { destructuring: 'all' }],
    'eqeqeq': ['error', 'always', { null: 'ignore' }],
    'no-implied-eval': 'error',
    'no-new-func': 'error',
    'no-proto': 'error'
};

export default [
    {
        ignores: [
            'node_modules/**',
            'data/**',
            'artifacts/**',
            '.trellis/**',
            '.pi/**',
            'coverage/**'
        ]
    },
    js.configs.recommended,
    {
        files: ['server.js', 'src/**/*.js'],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'commonjs',
            globals: {
                ...globals.node
            }
        },
        rules: {
            ...sharedRules,
            'no-console': 'off'
        }
    },
    {
        files: ['scripts/**/*.mjs', 'eslint.config.mjs', 'vitest.config.js'],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'module',
            globals: {
                ...globals.node
            }
        },
        rules: {
            ...sharedRules
        }
    },
    {
        files: ['public/admin-assets/**/*.js'],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'script',
            globals: {
                ...globals.browser
            }
        },
        rules: {
            ...sharedRules
        }
    },
    {
        files: ['test/**/*.test.js'],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'commonjs',
            globals: {
                ...globals.node,
                ...globals.vitest
            }
        },
        rules: {
            ...sharedRules
        }
    }
];
