import { describe, expect, it } from 'vitest';

import { parseKey, stepIntent } from './intent.js';

describe('stepIntent', () => {
  it('reads pointer gestures', () => {
    expect(stepIntent('Double click the "Double Click Me" button').pointer).toBe('dblclick');
    expect(stepIntent('Double-click the row').pointer).toBe('dblclick');
    expect(stepIntent('Right click inside the area and choose Copy').pointer).toBe('rightclick');
    expect(stepIntent('Hover over the tooltip button').pointer).toBe('hover');
    expect(stepIntent('Move the mouse over the menu').pointer).toBe('hover');
    expect(stepIntent('Click Register').pointer).toBeUndefined();
  });

  it('reads drags, keys and uploads', () => {
    expect(stepIntent('Drag "Deploy" onto the drop zone').drag).toBe(true);
    expect(stepIntent('Click the Press any key box and press Enter').key).toBe('Enter');
    expect(stepIntent('press Ctrl+A in the editor').key).toBe('Control+a');
    expect(stepIntent('Press the Arrow Down key').key).toBe('ArrowDown');
    expect(stepIntent('Press Esc to close').key).toBe('Escape');
    expect(stepIntent('Click the Press any key box').key).toBeUndefined();
    expect(stepIntent('Upload "photo.png" and click Upload').upload).toBe('photo.png');
    expect(stepIntent('Upload a photo').upload).toBeUndefined();
    expect(stepIntent('Clear the search and filter by role').clear).toBe(true);
    expect(stepIntent('Turn off the carousel autoplay').off).toBe(true);
    expect(stepIntent('Uncheck Remember me').off).toBe(true);
    expect(stepIntent('Turn on notifications').off).toBeUndefined();
  });

  it('parses key names and chords', () => {
    expect(parseKey('Shift + Tab')).toBe('Shift+Tab');
    expect(parseKey('F5')).toBe('F5');
    expect(parseKey('any')).toBeUndefined();
    expect(parseKey('Hyper+A')).toBeUndefined();
  });
});
