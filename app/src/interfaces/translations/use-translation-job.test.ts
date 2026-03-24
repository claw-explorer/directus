import { flushPromises } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { computed } from 'vue';
import { type TranslationJobConfig, useTranslationJob } from './use-translation-job';
import api from '@/api';

vi.mock('@/api', () => ({
	default: {
		post: vi.fn(),
	},
}));

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

const languageOptions = computed(() => [
	{ value: 'en', text: 'English' },
	{ value: 'fr', text: 'French' },
	{ value: 'es', text: 'Spanish' },
]);

function createJob() {
	const applyTranslatedFields = vi.fn();
	const job = useTranslationJob({ applyTranslatedFields, languageOptions });
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

function mockApiSuccess(data: Record<string, string> = { title: 'Translated' }) {
	vi.mocked(api.post).mockResolvedValue({ data: { data } });
}

function mockApiError(error: any) {
	vi.mocked(api.post).mockRejectedValue(error);
}

describe('useTranslationJob', () => {
	beforeEach(() => {
		vi.mocked(api.post).mockReset();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	test('start sets jobState to translating and inits langStatuses', () => {
		const { job } = createJob();

		// Hang the API so statuses stay in their initial state
		vi.mocked(api.post).mockImplementation(() => new Promise(() => {}));
		job.start({ ...baseConfig, targetLanguages: ['fr'] });

		expect(job.jobState.value).toBe('translating');
		expect(job.langStatuses.value['fr']?.status).toBe('translating');
		expect(job.totalCount.value).toBe(1);
		expect(job.isTranslating.value).toBe(true);
	});

	test('start calls api.post for each target and transitions to complete', async () => {
		const { job, applyTranslatedFields } = createJob();

		mockApiSuccess({ title: 'Bonjour' });
		job.start(baseConfig);
		await flushPromises();

		expect(api.post).toHaveBeenCalledTimes(2);

		expect(api.post).toHaveBeenCalledWith(
			'/ai/object',
			expect.objectContaining({
				provider: 'anthropic',
				model: 'claude-sonnet-4-5',
			}),
			expect.objectContaining({ signal: expect.any(AbortSignal) }),
		);

		expect(job.jobState.value).toBe('complete');
		expect(job.langStatuses.value['fr']).toEqual({ status: 'done', fieldCount: 1 });
		expect(job.langStatuses.value['es']).toEqual({ status: 'done', fieldCount: 1 });

		expect(applyTranslatedFields).toHaveBeenCalledTimes(2);
		expect(applyTranslatedFields).toHaveBeenCalledWith({ title: 'Bonjour' }, 'fr');
		expect(applyTranslatedFields).toHaveBeenCalledWith({ title: 'Bonjour' }, 'es');
	});

	test('cancel aborts requests and resets state', async () => {
		const { job, applyTranslatedFields } = createJob();

		// Make API hang so we can cancel mid-flight
		vi.mocked(api.post).mockImplementation(() => new Promise(() => {}));

		job.start(baseConfig);
		job.cancel();

		expect(job.jobState.value).toBe('idle');
		expect(Object.keys(job.langStatuses.value)).toHaveLength(0);

		await flushPromises();

		expect(applyTranslatedFields).not.toHaveBeenCalled();
	});

	test('start cancels any prior job', async () => {
		const { job } = createJob();

		vi.mocked(api.post).mockImplementation(() => new Promise(() => {}));
		job.start(baseConfig);

		expect(job.jobState.value).toBe('translating');

		mockApiSuccess();
		job.start({ ...baseConfig, targetLanguages: ['fr'] });
		await flushPromises();

		expect(job.jobState.value).toBe('complete');
		expect(Object.keys(job.langStatuses.value)).toEqual(['fr']);
	});

	test('API error sets error status with message', async () => {
		const { job } = createJob();

		mockApiError({
			response: {
				status: 500,
				data: { errors: [{ message: 'Bad request' }] },
			},
		});

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

		vi.mocked(api.post).mockImplementation(() => {
			callCount++;

			if (callCount === 1) {
				return Promise.reject({ response: { status: 429 } });
			}

			return Promise.resolve({ data: { data: { title: 'Bonjour' } } });
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

		mockApiError({ response: { status: 429 } });

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

		vi.mocked(api.post).mockImplementation(() => {
			callCount++;

			// First two calls succeed (fr, es), but make es fail
			if (callCount === 2) {
				return Promise.reject({ response: { status: 500, data: { errors: [{ message: 'fail' }] } } });
			}

			return Promise.resolve({ data: { data: { title: 'Translated' } } });
		});

		job.start(baseConfig);
		await flushPromises();

		expect(job.langStatuses.value['es']?.status).toBe('error');
		expect(job.langStatuses.value['fr']?.status).toBe('done');

		applyTranslatedFields.mockClear();
		vi.mocked(api.post).mockClear();
		mockApiSuccess({ title: 'Traducido' });

		await job.retry('es');

		expect(api.post).toHaveBeenCalledTimes(1);
		expect(job.langStatuses.value['es']).toEqual({ status: 'done', fieldCount: 1 });
		expect(applyTranslatedFields).toHaveBeenCalledWith({ title: 'Traducido' }, 'es');
		expect(job.jobState.value).toBe('complete');
	});

	test('CanceledError is silently ignored', async () => {
		const { job, applyTranslatedFields } = createJob();

		mockApiError({ name: 'CanceledError' });

		job.start({ ...baseConfig, targetLanguages: ['fr'] });
		await flushPromises();

		expect(applyTranslatedFields).not.toHaveBeenCalled();
		expect(job.langStatuses.value['fr']?.status).not.toBe('error');
	});

	test('reset clears all state back to initial', async () => {
		const { job } = createJob();

		mockApiSuccess();
		job.start({ ...baseConfig, targetLanguages: ['fr'] });
		await flushPromises();

		expect(job.jobState.value).toBe('complete');

		job.reset();

		expect(job.jobState.value).toBe('idle');
		expect(Object.keys(job.langStatuses.value)).toHaveLength(0);
		expect(job.pendingFields.value.size).toBe(0);
	});
});
