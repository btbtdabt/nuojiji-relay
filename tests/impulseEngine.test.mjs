import assert from 'node:assert/strict';
import { calculateImpulse } from '../src/proactive/impulseEngine.js';

const eveningProfile = {
    weights: { silence: 0, timeOfDay: 1, mood: 0, pendingQuestion: 0, randomLife: 0 },
    quietHours: [23, 8],
    silenceSaturationHours: 12,
    threshold: 0.5,
    randomLifeChancePerDay: 0,
};

function scoreAtUserEveningWithUtcCharacterClock() {
    return calculateImpulse({
        profile: eveningProfile,
        lifeState: {},
        now: Date.UTC(2026, 5, 16, 0, 0), // USER UTC-4 = 20:00; char/server UTC = 00:00 quiet hour.
        lastInteractionAt: Date.UTC(2026, 5, 15, 23, 0),
        charUtcOffsetSeconds: 0,
        userUtcOffsetSeconds: -4 * 3600,
    });
}

function scoreAtUtcQuietHourWithoutUserOffset() {
    return calculateImpulse({
        profile: eveningProfile,
        lifeState: {},
        now: Date.UTC(2026, 5, 16, 0, 0),
        lastInteractionAt: Date.UTC(2026, 5, 15, 23, 0),
        charUtcOffsetSeconds: 0,
    });
}

const userEvening = scoreAtUserEveningWithUtcCharacterClock();
assert.ok(userEvening.factors.timeOfDay > 0.5, `expected user evening to be non-quiet, got ${userEvening.factors.timeOfDay}`);

const charFallback = scoreAtUtcQuietHourWithoutUserOffset();
assert.equal(charFallback.factors.timeOfDay, 0.05);

console.log('impulseEngine tests passed');
