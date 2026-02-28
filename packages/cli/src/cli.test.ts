/**
 * CLI Tests
 *
 * These tests verify that the CLI entry point correctly dispatches
 * commands via command groups (workspace, local, remote, auth, data).
 */
import { describe, expect, test } from 'bun:test';
import { createCLI } from './cli';

describe('createCLI', () => {
	test('returns an object with a run method', () => {
		const cli = createCLI();
		expect(typeof cli.run).toBe('function');
	});

	test('shows usage when no arguments provided', async () => {
		const cli = createCLI();
		const originalError = console.error;
		let errorOutput = '';
		console.error = (msg: string) => {
			errorOutput += msg;
		};

		await cli.run([]);

		console.error = originalError;
		expect(errorOutput).toContain('epicenter');
		expect(process.exitCode).toBe(1);
		process.exitCode = undefined;
	});
});
