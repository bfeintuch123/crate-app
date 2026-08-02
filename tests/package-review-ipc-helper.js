'use strict';

function createAutomaticPackageReviewCaller(callIpcRaw) {
  const reviewsByProject = new Map();
  return async function callIpc(channel, ...args) {
    if (channel !== 'projects:package' || args.length >= 3) return callIpcRaw(channel, ...args);

    const projectId = args[0];
    let reviewPromise = reviewsByProject.get(projectId);
    if (!reviewPromise) {
      reviewPromise = Promise.resolve(callIpcRaw('projects:prepare-package-review', projectId));
      reviewsByProject.set(projectId, reviewPromise);
    }
    try {
      const review = await reviewPromise;
      if (!review || review.error || !review.token) return review;
      const result = await callIpcRaw(channel, ...args, review.token);
      if (
        result?.error === 'package_review_changed' &&
        result.reason === 'package_destination_changed' &&
        result.review?.token
      ) {
        return callIpcRaw(channel, ...args, result.review.token);
      }
      return result;
    } finally {
      if (reviewsByProject.get(projectId) === reviewPromise) reviewsByProject.delete(projectId);
    }
  };
}

module.exports = { createAutomaticPackageReviewCaller };
