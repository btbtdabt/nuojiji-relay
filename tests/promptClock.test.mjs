import assert from 'node:assert/strict';
import { addUserClockToMessages, addUserClockToPrompt } from '../src/util/promptClock.js';

const SAME_ZONE_PROMPT = [
    '[USER] 艾米|女|birthday:1998年10月9日',
    '[BIO] NOW:2026年6月18日 星期四 01:02【凌晨】weekday | Live conversation',
    '⚠️CLOCK-ANCHOR: NOW=01:02 is YOUR live local time.',
].join('\n');

{
    const out = addUserClockToPrompt(SAME_ZONE_PROMPT, {
        timeSpec: { userUtcOffsetSeconds: -4 * 3600 },
        now: Date.UTC(2026, 5, 18, 5, 2),
    });
    assert.match(out, /\[BIO\] NOW:2026年6月18日 星期四 01:02/);
    assert.match(out, /USER_LOCAL_TIME=2026年6月18日 星期四 01:02/);
    assert.match(out, /judge 艾米's date, sleep, meals, and availability by NOW/);
}

{
    const out = addUserClockToPrompt(SAME_ZONE_PROMPT, {
        timeSpec: { charUtcOffsetSeconds: 9 * 3600, userUtcOffsetSeconds: -4 * 3600 },
        now: Date.UTC(2026, 5, 18, 5, 2),
    });
    assert.match(out, /USER_LOCAL_TIME=2026年6月18日 星期四 01:02/);
    assert.match(out, /judge 艾米's date, sleep, meals, and availability by USER_LOCAL_TIME/);
}

{
    const once = addUserClockToPrompt(SAME_ZONE_PROMPT, {
        timeSpec: { userUtcOffsetSeconds: -4 * 3600 },
        now: Date.UTC(2026, 5, 18, 5, 2),
    });
    const twice = addUserClockToPrompt(once, {
        timeSpec: { userUtcOffsetSeconds: -4 * 3600 },
        now: Date.UTC(2026, 5, 18, 5, 2),
    });
    assert.equal(twice, once);
}

{
    const prompt = SAME_ZONE_PROMPT.replace('Live conversation', 'Live conversation | USER_LOCAL_TIME=already there');
    assert.equal(addUserClockToPrompt(prompt, {
        timeSpec: { userUtcOffsetSeconds: -4 * 3600 },
        now: Date.UTC(2026, 5, 18, 5, 2),
    }), prompt);
}

{
    const messages = addUserClockToMessages([
        { role: 'system', content: SAME_ZONE_PROMPT },
        { role: 'user', content: 'hello' },
    ], {
        timeSpec: { userUtcOffsetSeconds: -4 * 3600 },
        now: Date.UTC(2026, 5, 18, 5, 2),
    });
    assert.match(messages[0].content, /USER_LOCAL_TIME=2026年6月18日 星期四 01:02/);
    assert.equal(messages[1].content, 'hello');
}
