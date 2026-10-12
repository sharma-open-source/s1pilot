import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { StepGuide } from './StepGuide';

describe('StepGuide', () => {
  it('starts collapsed and expands on click', async () => {
    const { container } = render(<StepGuide />);
    const details = container.querySelector('details');
    expect(details?.open).toBe(false);
    await userEvent.click(screen.getByText('How to write steps'));
    expect(details?.open).toBe(true);
  });

  it('starts open for a new case and lists quoting and waiting examples', () => {
    const { container, rerender } = render(<StepGuide defaultOpen />);
    expect(container.querySelector('details')?.open).toBe(true);
    expect(screen.getByText('Type "js" in the Search box')).toBeTruthy();
    expect(screen.getByText('Wait until "Upload complete" appears')).toBeTruthy();
    expect(screen.getByText(/Put the text to type in double quotes/)).toBeTruthy();
    // Typing the first step (no longer "new") must not close it.
    rerender(<StepGuide defaultOpen={false} />);
    expect(container.querySelector('details')?.open).toBe(true);
  });
});
