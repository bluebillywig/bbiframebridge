// Mirrors standardplayer's jest setup so the two repos stay consistent.
module.exports = {
	testEnvironment: 'jsdom',
	transform: {
		'^.+\\.js$': ['babel-jest', { configFile: './jest.babel.config.json' }]
	},
	testPathIgnorePatterns: [
		'/node_modules/',
		'/dist/'
	],
	collectCoverageFrom: [
		'src/**/*.js',
		'!src/**/*.test.js',
		'!src/index.js',
		'!src/standalone.js'
	],
	coverageDirectory: 'coverage',
	coverageReporters: ['text-summary', 'text', 'html']
};
