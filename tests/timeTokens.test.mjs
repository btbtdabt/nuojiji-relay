import assert from 'node:assert/strict';
import { renderTimeTokens } from '../src/util/timeTokens.js';

const periodTable = Array.from({ length: 24 }, (_, hour) => ({
    label: `period-${hour}`,
    greetOk: `ok-${hour}`,
    greetBan: `ban-${hour}`,
}));

function testCharacterOffsetDrivesMainNowTokensWhenCharacterOffsetExists() {
    const now = Date.UTC(2026, 5, 16, 0, 0); // 2026-06-15 20:00 at UTC-4, 09:00 at UTC+9.
    const rendered = renderTimeTokens(
        'time=§NOW_TIME§ date=§NOW_DATE§ period=§NOW_PERIOD§ greet=§NOW_GREET_OK§/§NOW_GREET_BAN§ clock=§NOW_USERCLOCK§',
        {
            charName: 'Aki',
            charUtcOffsetSeconds: 9 * 3600,
            userUtcOffsetSeconds: -4 * 3600,
            periodTable,
        },
        now,
    );

    assert.match(rendered, /time=09:00/);
    assert.match(rendered, /date=2026年6月16日 星期二/);
    assert.match(rendered, /period=period-9/);
    assert.match(rendered, /greet=ok-9\/ban-9/);
    assert.match(rendered, /YOUR_LOCAL_TIME\(Aki\)=2026年6月16日 星期二 09:00, USER_LOCAL_TIME=2026年6月15日 星期一 20:00/);
    assert.match(rendered, /judge the user's date, sleep, meals, and availability by USER_LOCAL_TIME/);
}

function testUserOffsetStillDrivesMainNowTokensWithoutCharacterOffset() {
    const now = Date.UTC(2026, 5, 16, 0, 0);
    const rendered = renderTimeTokens(
        'time=§NOW_TIME§ period=§NOW_PERIOD§ clock=§NOW_USERCLOCK§',
        {
            userUtcOffsetSeconds: -4 * 3600,
            periodTable,
        },
        now,
    );

    assert.equal(
        rendered,
        'time=20:00 period=period-20 clock= | USER_LOCAL_TIME=2026年6月15日 星期一 20:00 (same as NOW in this chat; judge the user\'s date, sleep, meals, and availability by NOW)',
    );
}

function testCharacterOffsetIsFallbackWhenUserOffsetIsUnavailable() {
    const now = Date.UTC(2026, 5, 16, 0, 0);
    const rendered = renderTimeTokens(
        'time=§NOW_TIME§ period=§NOW_PERIOD§',
        {
            charUtcOffsetSeconds: 9 * 3600,
            periodTable,
        },
        now,
    );

    assert.equal(rendered, 'time=09:00 period=period-9');
}

testCharacterOffsetDrivesMainNowTokensWhenCharacterOffsetExists();
testUserOffsetStillDrivesMainNowTokensWithoutCharacterOffset();
testCharacterOffsetIsFallbackWhenUserOffsetIsUnavailable();

console.log('timeTokens tests passed');
