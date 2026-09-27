/** Resolves on the next animation frame, so the page can paint between steps of a long job. */
export const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
