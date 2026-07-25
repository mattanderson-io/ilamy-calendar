import { afterEach, describe, expect, it } from 'bun:test'
// This suite needs an UNCONFIGURED dayjs as an independent oracle: the whole
// point is comparing the configured constructor against the plain one.
// biome-ignore lint/style/noRestrictedImports: intentional unconfigured oracle
import rawDayjs from 'dayjs'
import timezone from 'dayjs/plugin/timezone.js'
import utc from 'dayjs/plugin/utc.js'
import dayjs from './dayjs'

rawDayjs.extend(utc)
rawDayjs.extend(timezone)

/**
 * The configured `dayjs` used to route EVERY construction through `dayjs.tz()`,
 * at ~20us versus ~143ns for a plain construction. It now takes a fast path when
 * the two provably agree.
 *
 * The condition is narrow and these tests pin both halves of it: the shapes that
 * may take the fast path must be indistinguishable from the plain constructor,
 * and the shapes that may NOT must keep the tz-reinterpretation behaviour, which
 * this library depends on.
 */

/** Full identity of an instance: instant, day boundary, and rendered wall clock. */
const shapeOf = (instance: {
	valueOf: () => number
	startOf: (unit: 'day') => { valueOf: () => number }
	format: (template: string) => string
}) => ({
	ms: instance.valueOf(),
	day: instance.startOf('day').valueOf(),
	text: instance.format('YYYY-MM-DDTHH:mm:ss'),
})

afterEach(() => {
	dayjs.tz.setDefault()
})

describe('configured dayjs constructor, no default timezone', () => {
	/**
	 * Inputs with no offset designator. `dayjs.tz()` and the plain constructor
	 * both interpret these as local wall clock when no default zone is set, so the
	 * fast path must be indistinguishable — not merely equal in timestamp, but
	 * identical in day boundary and formatted output too.
	 */
	const equivalentInputs: [string, unknown][] = [
		['date-only string', '2026-03-02'],
		['local datetime string', '2026-03-02T09:00:00'],
		['local datetime with ms', '2026-03-02T09:00:00.000'],
		['slash-separated date', '2026/03/02'],
		['epoch millis', 1_772_442_000_000],
		['Date object', new Date('2026-03-02T09:00:00.000Z')],
		['spring-forward local string', '2026-03-08T02:30:00'],
		['fall-back local string', '2026-11-01T01:30:00'],
		['leap day', '2028-02-29T12:00:00'],
	]

	it.each(
		equivalentInputs
	)('matches the plain constructor for %s', (_label: string, input: unknown) => {
		dayjs.tz.setDefault()
		// biome-ignore lint/suspicious/noExplicitAny: exercising loose input shapes
		expect(shapeOf(dayjs(input as any))).toEqual(
			// biome-ignore lint/suspicious/noExplicitAny: exercising loose input shapes
			shapeOf(rawDayjs(input as any))
		)
	})

	it('matches for no arguments', () => {
		dayjs.tz.setDefault()
		const configured = dayjs()
		const plain = rawDayjs()
		expect(Math.abs(configured.valueOf() - plain.valueOf())).toBeLessThan(1000)
		expect(configured.startOf('day').valueOf()).toBe(
			plain.startOf('day').valueOf()
		)
	})

	it('matches when passed an existing Dayjs instance', () => {
		dayjs.tz.setDefault()
		const source = dayjs('2026-03-02T09:00:00')
		expect(shapeOf(dayjs(source))).toEqual(shapeOf(source))
	})

	it('produces a valid instance for unparseable input, as before', () => {
		dayjs.tz.setDefault()
		expect(dayjs('not a date').isValid()).toBe(rawDayjs('not a date').isValid())
	})

	/**
	 * Offset-bearing strings must NOT take the fast path. `dayjs.tz()` ignores the
	 * designator and reinterprets the wall-clock fields in the target zone, which
	 * yields a different instant from the plain constructor. Preserved deliberately.
	 */
	const offsetInputs: [string, string][] = [
		['Z-suffixed', '2026-03-02T09:00:00.000Z'],
		['Z-suffixed without ms', '2026-03-02T09:00:00Z'],
		['positive offset', '2026-03-02T09:00:00+05:30'],
		['negative offset', '2026-03-02T09:00:00-08:00'],
		['compact offset', '2026-03-02T09:00:00+0530'],
		['lowercase z', '2026-03-02T09:00:00z'],
	]

	it.each(
		offsetInputs
	)('keeps the timezone-reinterpreting behaviour for %s', (_label: string, input: string) => {
		dayjs.tz.setDefault()
		// Equal to what the tz path produces...
		expect(dayjs(input).valueOf()).toBe(rawDayjs.tz(input).valueOf())
		// ...and, on a machine whose local zone is not UTC, deliberately NOT
		// equal to the plain constructor. Skipped under UTC, where they coincide.
		const localZone = Intl.DateTimeFormat().resolvedOptions().timeZone
		if (localZone !== 'UTC' && localZone !== 'Etc/UTC') {
			expect(dayjs(input).valueOf()).not.toBe(rawDayjs(input).valueOf())
		}
	})
})

describe('configured dayjs constructor, default timezone set', () => {
	// Deliberately not the machine's local zone: with a local zone the two paths
	// coincide and the assertions would prove nothing.
	const ZONE = 'Asia/Tokyo'

	const inputs: [string, unknown][] = [
		['date-only string', '2026-03-02'],
		['local datetime string', '2026-03-02T09:00:00'],
		['Z-suffixed string', '2026-03-02T09:00:00.000Z'],
		['epoch millis', 1_772_442_000_000],
		['Date object', new Date('2026-03-02T09:00:00.000Z')],
	]

	it.each(
		inputs
	)('still routes %s through the configured zone', (_label: string, input: unknown) => {
		dayjs.tz.setDefault(ZONE)
		// biome-ignore lint/suspicious/noExplicitAny: exercising loose input shapes
		expect(shapeOf(dayjs(input as any))).toEqual(
			// biome-ignore lint/suspicious/noExplicitAny: exercising loose input shapes
			shapeOf(rawDayjs.tz(input as any, ZONE))
		)
	})

	it('reports the configured zone offset, not the local one', () => {
		dayjs.tz.setDefault(ZONE)
		// Tokyo is UTC+9 year round.
		expect(dayjs('2026-03-02T09:00:00').utcOffset()).toBe(540)
	})

	it('honours a timezone set after earlier fast-path constructions', () => {
		dayjs.tz.setDefault()
		const beforeOffset = dayjs('2026-03-02T09:00:00').utcOffset()
		dayjs.tz.setDefault(ZONE)
		expect(dayjs('2026-03-02T09:00:00').utcOffset()).toBe(540)
		dayjs.tz.setDefault()
		// And returns to the fast path when cleared again.
		expect(dayjs('2026-03-02T09:00:00').utcOffset()).toBe(beforeOffset)
	})
})

describe('configured dayjs constructor, multi-argument calls', () => {
	it('does not change behaviour when a second argument is supplied', () => {
		dayjs.tz.setDefault()
		// `dayjs.tz`'s second parameter is a TIMEZONE, not a format, so this has
		// always thrown. The fast path deliberately does not intercept it: silently
		// changing it would fix one bug inside an unrelated performance change.
		// Tracked separately.
		expect(() => dayjs('2026-03-02', 'YYYY-MM-DD')).toThrow()
	})

	it('accepts a valid timezone as the second argument', () => {
		dayjs.tz.setDefault()
		expect(dayjs('2026-03-02T09:00:00', 'Asia/Tokyo').utcOffset()).toBe(540)
	})
})
