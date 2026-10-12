/** Consequences of deleting test cases, shown in the delete confirmation (cases list and case editor). */
export function DeleteCasesWarning({ count }: { count: number }) {
  const one = count === 1;
  return (
    <>
      {one ? 'Its' : 'Their'} results in past runs, version history and learned scripts are deleted too, and {one ? 'it is' : 'they are'}{' '}
      removed from plans that list {one ? 'it' : 'them'}. This cannot be undone. To keep the history, set the status to Deprecated instead.
    </>
  );
}
