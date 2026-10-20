// Failed jobs can still own live processes. Only proven terminal states are history.
export function splitBackgroundJobs(jobs = []) {
  const current = [], history = []
  for (const job of jobs) (['completed', 'killed', 'confirmed-stopped'].includes(job.status) ? history : current).push(job)
  return { current, history }
}

// A literal excerpt, never an inferred result. Preserve the full source on expansion.
export function boardExcerpt(text, limit = 100) {
  const source = String(text ?? '').trim()
  if (Array.from(source).length <= limit) return null
  const firstParagraph = source.split(/\n\s*\n/, 1)[0]
  return Array.from(firstParagraph).slice(0, limit).join('') + '…'
}
