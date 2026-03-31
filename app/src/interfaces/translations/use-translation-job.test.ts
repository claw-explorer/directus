import { flushPromises } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { computed } from 'vue';
import { type TranslationJobConfig, useTranslationJob } from './use-translation-job';

vi.mock('@/stores/settings', () => ({
	useSettingsStore: () => ({
		settings: {},
	}),
}));

vi.mock('@vueuse/core', () => ({
	useEventListener: vi.fn(),
}));

vi.mock('vue-i18n', () => ({
	useI18n: () => ({
		t: (key: string) => key,
	}),
}));

vi.mock('@/utils/get-root-path', () => ({
	getRootPath: () => '/',
}));

const languageOptions = computed(() => [
	{ value: 'en', text: 'English' },
	{ value: 'fr', text: 'French' },
	{ value: 'es', text: 'Spanish' },
]);

const currentLanguage = computed(() => 'fr');

function createJob() {
	const applyTranslatedFields = vi.fn();
	const job = useTranslationJob({ applyTranslatedFields, languageOptions, currentLanguage });
	return { job: job!, applyTranslatedFields };
}

const baseConfig: TranslationJobConfig = {
	sourceLanguage: 'en',
	selectedFields: ['title'],
	targetLanguages: ['fr', 'es'],
	model: { provider: 'anthropic', model: 'claude-sonnet-4-5' } as any,
	sourceContent: { title: 'Hello' },
	fieldDefinitions: [{ field: 'title', type: 'string', meta: { interface: 'input' } }] as any,
};

function createStreamResponse(json: string) {
	const encoder = new TextEncoder();

	const stream = new ReadableStream({
		start(controller) {
			controller.enqueue(encoder.encode(json));
			controller.close();
		},
	});

	return new Response(stream, {
		status: 200,
		headers: { 'Content-Type': 'text/plain; charset=utf-8' },
	});
}

function createErrorResponse(status: number, body?: any) {
	return new Response(JSON.stringify(body ?? { errors: [{ message: 'Server error' }] }), {
		status,
		headers: { 'Content-Type': 'application/json' },
	});
}

function mockFetchStream(json: string = '{"title":"Translated"}') {
	vi.spyOn(globalThis, 'fetch').mockImplementation(() => Promise.resolve(createStreamResponse(json)));
}

function mockFetchError(status: number, body?: any) {
	vi.spyOn(globalThis, 'fetch').mockImplementation(() => Promise.resolve(createErrorResponse(status, body)));
}

function mockFetchHang() {
	vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise(() => {}));
}

describe('useTranslationJob', () => {
	beforeEach(() => {
		vi.restoreAllMocks();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	test('start sets jobState to translating and inits langStatuses', () => {
		const { job } = createJob();

		mockFetchHang();
		job.start({ ...baseConfig, targetLanguages: ['fr'] });

		expect(job.jobState.value).toBe('translating');
		expect(job.langStatuses.value['fr']?.status).toBe('translating');
		expect(job.totalCount.value).toBe(1);
		expect(job.isTranslating.value).toBe(true);
	});

	test('start streams and applies translations then transitions to complete', async () => {
		const { job, applyTranslatedFields } = createJob();

		mockFetchStream('{"title":"Bonjour"}');
		job.start(baseConfig);
		await flushPromises();

		expect(globalThis.fetch).toHaveBeenCalledTimes(2);

		expect(job.jobState.value).toBe('complete');
		expect(job.langStatuses.value['fr']).toEqual({ status: 'done', fieldCount: 1 });
		expect(job.langStatuses.value['es']).toEqual({ status: 'done', fieldCount: 1 });

		expect(applyTranslatedFields).toHaveBeenCalledTimes(2);
		expect(applyTranslatedFields).toHaveBeenCalledWith({ title: 'Bonjour' }, 'fr');
		expect(applyTranslatedFields).toHaveBeenCalledWith({ title: 'Bonjour' }, 'es');
	});

	test('cancel aborts requests and resets state', async () => {
		const { job, applyTranslatedFields } = createJob();

		mockFetchHang();

		job.start(baseConfig);
		job.cancel();

		expect(job.jobState.value).toBe('idle');
		expect(Object.keys(job.langStatuses.value)).toHaveLength(0);

		await flushPromises();

		expect(applyTranslatedFields).not.toHaveBeenCalled();
	});

	test('start cancels any prior job', async () => {
		const { job } = createJob();

		mockFetchHang();
		job.start(baseConfig);

		expect(job.jobState.value).toBe('translating');

		mockFetchStream();
		job.start({ ...baseConfig, targetLanguages: ['fr'] });
		await flushPromises();

		expect(job.jobState.value).toBe('complete');
		expect(Object.keys(job.langStatuses.value)).toEqual(['fr']);
	});

	test('API error sets error status with message', async () => {
		const { job } = createJob();

		mockFetchError(500, { errors: [{ message: 'Bad request' }] });

		job.start({ ...baseConfig, targetLanguages: ['fr'] });
		await flushPromises();

		expect(job.langStatuses.value['fr']).toEqual({
			status: 'error',
			error: 'Bad request',
		});

		expect(job.jobState.value).toBe('complete');
		expect(job.hasErrors.value).toBe(true);
	});

	test('429 retries with exponential backoff then succeeds', async () => {
		vi.useFakeTimers();

		const { job, applyTranslatedFields } = createJob();

		let callCount = 0;

		vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
			callCount++;

			if (callCount === 1) {
				return Promise.resolve(createErrorResponse(429));
			}

			return Promise.resolve(createStreamResponse('{"title":"Bonjour"}'));
		});

		job.start({ ...baseConfig, targetLanguages: ['fr'] });
		await flushPromises();

		expect(job.langStatuses.value['fr']?.status).toBe('retrying');

		await vi.advanceTimersByTimeAsync(1000);
		await flushPromises();

		expect(job.langStatuses.value['fr']).toEqual({ status: 'done', fieldCount: 1 });
		expect(applyTranslatedFields).toHaveBeenCalledWith({ title: 'Bonjour' }, 'fr');

		vi.useRealTimers();
	});

	test('429 exhausts retries and sets error', async () => {
		vi.useFakeTimers();

		const { job } = createJob();

		mockFetchError(429);

		job.start({ ...baseConfig, targetLanguages: ['fr'] });

		// Exhaust all retries (3 retries with exponential backoff: 1s, 2s, 4s)
		for (let i = 0; i < 3; i++) {
			await flushPromises();
			await vi.advanceTimersByTimeAsync(Math.pow(2, i) * 1000);
		}

		await flushPromises();

		expect(job.langStatuses.value['fr']?.status).toBe('error');
		expect(job.jobState.value).toBe('complete');

		vi.useRealTimers();
	});

	test('retry re-translates a single failed language', async () => {
		const { job, applyTranslatedFields } = createJob();

		let callCount = 0;

		vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
			callCount++;

			if (callCount === 2) {
				return Promise.resolve(createErrorResponse(500, { errors: [{ message: 'fail' }] }));
			}

			return Promise.resolve(createStreamResponse('{"title":"Translated"}'));
		});

		job.start(baseConfig);
		await flushPromises();

		expect(job.langStatuses.value['es']?.status).toBe('error');
		expect(job.langStatuses.value['fr']?.status).toBe('done');

		applyTranslatedFields.mockClear();

		vi.spyOn(globalThis, 'fetch').mockResolvedValue(createStreamResponse('{"title":"Traducido"}'));

		await job.retry('es');

		expect(job.langStatuses.value['es']).toEqual({ status: 'done', fieldCount: 1 });
		expect(applyTranslatedFields).toHaveBeenCalledWith({ title: 'Traducido' }, 'es');
		expect(job.jobState.value).toBe('complete');
	});

	test('AbortError is silently ignored', async () => {
		const { job, applyTranslatedFields } = createJob();

		vi.spyOn(globalThis, 'fetch').mockRejectedValue(Object.assign(new Error('Aborted'), { name: 'AbortError' }));

		job.start({ ...baseConfig, targetLanguages: ['fr'] });
		await flushPromises();

		expect(applyTranslatedFields).not.toHaveBeenCalled();
		expect(job.langStatuses.value['fr']?.status).not.toBe('error');
	});

	test('retry sets jobState to translating during retry', async () => {
		const { job } = createJob();

		let callCount = 0;

		vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
			callCount++;

			if (callCount === 1) {
				return Promise.resolve(createErrorResponse(500, { errors: [{ message: 'fail' }] }));
			}

			return Promise.resolve(createStreamResponse('{"title":"Translated"}'));
		});

		job.start({ ...baseConfig, targetLanguages: ['fr'] });
		await flushPromises();

		expect(job.langStatuses.value['fr']?.status).toBe('error');
		expect(job.jobState.value).toBe('complete');

		vi.spyOn(globalThis, 'fetch').mockResolvedValue(createStreamResponse('{"title":"OK"}'));

		const retryPromise = job.retry('fr');

		expect(job.jobState.value).toBe('translating');

		await retryPromise;

		expect(job.langStatuses.value['fr']?.status).toBe('done');
		expect(job.jobState.value).toBe('complete');
	});

	test('reset clears all state back to initial', async () => {
		const { job } = createJob();

		mockFetchStream();
		job.start({ ...baseConfig, targetLanguages: ['fr'] });
		await flushPromises();

		expect(job.jobState.value).toBe('complete');

		job.reset();

		expect(job.jobState.value).toBe('idle');
		expect(Object.keys(job.langStatuses.value)).toHaveLength(0);
		expect(job.pendingFields.value.size).toBe(0);
	});

	test('activeStreamingField tracks current field for viewed language', async () => {
		const { job } = createJob();

		// Create a stream that sends data in chunks
		const encoder = new TextEncoder();
		let controller: ReadableStreamDefaultController<Uint8Array>;

		const stream = new ReadableStream<Uint8Array>({
			start(c) {
				controller = c;
			},
		});

		vi.spyOn(globalThis, 'fetch').mockResolvedValue(
			new Response(stream, {
				status: 200,
				headers: { 'Content-Type': 'text/plain; charset=utf-8' },
			}),
		);

		job.start({ ...baseConfig, targetLanguages: ['fr'] });

		// Wait for fetch to resolve
		await flushPromises();

		expect(job.activeStreamingField.value).toBeNull();

		// Send first chunk with partial first field
		controller!.enqueue(encoder.encode('{"title":"Bon'));
		await flushPromises();

		expect(job.activeStreamingField.value).toBe('title');

		// Complete the stream
		controller!.enqueue(encoder.encode('jour"}'));
		controller!.close();
		await flushPromises();

		expect(job.activeStreamingField.value).toBeNull();
	});
});
