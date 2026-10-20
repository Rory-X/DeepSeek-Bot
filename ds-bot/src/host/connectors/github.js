// GitHub through GitHub's own MCP server: 23 named read tools, and 17 writes that ask on
// the approval card first. Nothing is a generic proxy: the mount lists the server's tools
// and keeps only the names declared here, so a tool that is not listed cannot be called.
// The ten blocked names are never declared, which keeps them out of the mount entirely.

const GITHUB_MCP = 'https://api.githubcopilot.com/mcp/'
const GITHUB_API = 'https://api.github.com'

// Context, issues, pull requests and repositories — the reads DS Bot exposes.
export const READ_TOOLS = [
  'get_me', 'get_teams',
  'list_issues', 'issue_read', 'search_issues', 'get_label', 'list_issue_types', 'list_issue_fields',
  'list_pull_requests', 'pull_request_read', 'search_pull_requests',
  'get_commit', 'get_file_contents', 'list_branches', 'list_commits', 'list_releases',
  'get_latest_release', 'get_release_by_tag', 'get_tag', 'list_tags', 'search_code',
  'search_commits', 'search_repositories',
]

// Every call below passes the approval card before it runs.
export const ACTION_TOOLS = [
  'add_issue_comment', 'issue_write', 'sub_issue_write', 'update_issue_comment',
  'add_comment_to_pending_review', 'add_reply_to_pull_request_comment', 'create_pull_request',
  'merge_pull_request', 'pull_request_review_write', 'update_pull_request',
  'update_pull_request_branch', 'create_branch', 'create_or_update_file', 'create_repository',
  'delete_file', 'fork_repository', 'push_files',
]

// Never offered, whether or not the server lists them: repository destruction and settings,
// branch deletion (read-tools cannot read a repository's default branch, so it cannot refuse
// to delete it), force pushes, and credentials, organizations or webhooks.
export const BLOCKED_TOOLS = [
  'delete_repository',
  'transfer_repository',
  'archive_repository',
  'update_repository',
  'delete_branch',
  'force_push',
  'create_token',
  'revoke_token',
  'create_ssh_key',
  'manage_webhook',
]

const repoOf = (args) => (typeof args?.owner === 'string' && args.owner !== ''
  && typeof args?.repo === 'string' && args.repo !== '' ? `${args.owner}/${args.repo}` : undefined)
const numberTarget = (args, key) => {
  const repo = repoOf(args)
  if (repo === undefined) return undefined
  const number = args?.[key]
  return typeof number === 'number' || (typeof number === 'string' && number !== '') ? `${repo}#${number}` : repo
}
const fileTarget = (args) => {
  const repo = repoOf(args)
  if (repo === undefined || typeof args?.path !== 'string' || args.path === '') return repo
  return `${repo} ${args.path}`
}
const branchTarget = (args) => {
  const repo = repoOf(args)
  if (repo === undefined || typeof args?.branch !== 'string' || args.branch === '') return repo
  return `${repo} ${args.branch}`
}
const text = (value, fallback) => (typeof value === 'string' && value !== '' ? value : fallback)
const count = (files) => (Array.isArray(files) ? files.length : 0)

// The card's one line and what the call changes. `reversible:false` means GitHub cannot undo
// it and the card asks for the acknowledgement; `change` says where it could be undone.
export function approvalFor(name, args) {
  const repo = repoOf(args)
  const issue = numberTarget(args, 'issue_number')
  const pull = numberTarget(args, 'pullNumber')
  const method = typeof args?.method === 'string' ? args.method : ''
  switch (name) {
    case 'add_issue_comment':
      return { line: `Comment on ${text(issue, 'an issue')}`, ...(issue === undefined ? {} : { target: issue }), change: 'adds a comment', reversible: true }
    case 'issue_write': {
      if (method === 'create') {
        return {
          line: `Create an issue in ${text(repo, 'a repository')}`,
          ...(repo === undefined ? {} : { target: repo }),
          change: 'creates an issue; there is no delete-issue tool, so this cannot be undone here',
          reversible: false,
        }
      }
      const closing = args?.state === 'closed'
      return {
        line: `${closing ? 'Close' : 'Update'} issue ${text(issue, 'an issue')}`,
        ...(issue === undefined ? {} : { target: issue }),
        change: closing ? 'closes the issue' : 'updates the issue',
        reversible: true,
      }
    }
    case 'sub_issue_write':
      return {
        line: `${method === 'remove' ? 'Remove' : method === 'reprioritize' ? 'Reorder' : 'Add'} sub-issue on ${text(issue, 'an issue')}`,
        ...(issue === undefined ? {} : { target: issue }),
        change: method === 'remove' ? 'unlinks a sub-issue' : 'links or reorders a sub-issue',
        reversible: true,
      }
    case 'update_issue_comment':
      return {
        line: `Edit comment ${text(String(args?.comment_id ?? ''), 'on an issue')} in ${text(repo, 'a repository')}`,
        ...(repo === undefined ? {} : { target: repo }),
        change: 'rewrites the comment text',
        reversible: true,
      }
    case 'add_comment_to_pending_review':
      return {
        line: `Add review comment to ${text(pull, 'a pull request')} at ${text(args?.path, 'a file')}`,
        ...(pull === undefined ? {} : { target: pull }),
        change: 'queues a review comment; it is published with the review',
        reversible: true,
      }
    case 'add_reply_to_pull_request_comment': {
      const comment = String(args?.commentId ?? '')
      return {
        line: `${comment === '' ? 'Reply to a review comment' : `Reply to review comment ${comment}`} on ${text(pull, 'a pull request')}`,
        ...(pull === undefined ? {} : { target: pull }),
        change: 'adds a reply',
        reversible: true,
      }
    }
    case 'create_pull_request':
      return {
        line: `Open PR ${text(args?.head, 'a branch')} → ${text(args?.base, 'the base')} in ${text(repo, 'a repository')}`,
        ...(repo === undefined ? {} : { target: repo }),
        change: 'creates a pull request',
        reversible: true,
      }
    case 'merge_pull_request':
      return {
        line: `Merge PR ${text(pull, 'a pull request')} into ${text(args?.base, 'its base')}`,
        ...(pull === undefined ? {} : { target: pull }),
        change: 'merges the pull request; this cannot be undone',
        reversible: false,
        danger: true,
      }
    case 'pull_request_review_write':
      if (method === 'delete_pending') {
        return {
          line: `Delete the pending review on ${text(pull, 'a pull request')}`,
          ...(pull === undefined ? {} : { target: pull }),
          change: 'deletes the pending review; this cannot be undone',
          reversible: false,
          danger: true,
        }
      }
      return {
        line: `${method === 'submit_pending' ? 'Submit' : method === 'resolve_thread' ? 'Resolve' : method === 'unresolve_thread' ? 'Reopen' : 'Write'} a review on ${text(pull, 'a pull request')}`,
        ...(pull === undefined ? {} : { target: pull }),
        change: 'writes a review',
        reversible: true,
      }
    case 'update_pull_request':
      return { line: `Update PR ${text(pull, 'a pull request')}`, ...(pull === undefined ? {} : { target: pull }), change: 'updates the pull request', reversible: true }
    case 'update_pull_request_branch':
      return {
        line: `Update the branch of PR ${text(pull, 'a pull request')} from its base`,
        ...(pull === undefined ? {} : { target: pull }),
        change: 'merges the base branch into the pull request branch',
        reversible: true,
      }
    case 'create_branch':
      return {
        line: `Create branch ${text(args?.branch, 'a branch')} in ${text(repo, 'a repository')}`,
        ...(branchTarget(args) === undefined ? {} : { target: branchTarget(args) }),
        change: 'adds a branch; only GitHub web can delete it',
        reversible: false,
      }
    case 'create_or_update_file':
      return {
        line: `Write ${text(args?.path, 'a file')} on ${text(args?.branch, 'a branch')} in ${text(repo, 'a repository')}`,
        ...(fileTarget(args) === undefined ? {} : { target: `${fileTarget(args)} on ${text(args?.branch, 'a branch')}` }),
        change: 'commits the file content; the commit history keeps the old content',
        reversible: true,
        danger: true,
      }
    case 'create_repository': {
      const org = text(args?.organization, '')
      const name = text(args?.name, 'a repository')
      return {
        line: `Create repository ${org === '' ? name : `${org}/${name}`}`,
        ...(text(args?.name, '') === '' ? {} : { target: org === '' ? args.name : `${org}/${args.name}` }),
        change: 'creates a repository; this cannot be undone here',
        reversible: false,
        danger: true,
      }
    }
    case 'delete_file':
      return {
        line: `Delete ${text(args?.path, 'a file')} on ${text(args?.branch, 'a branch')} in ${text(repo, 'a repository')}`,
        ...(fileTarget(args) === undefined ? {} : { target: fileTarget(args) }),
        change: 'deletes the file from the branch; the commit history keeps the old content',
        reversible: true,
        danger: true,
      }
    case 'fork_repository':
      return {
        line: `Fork ${text(repo, 'a repository')} to ${text(args?.organization, 'your account')}`,
        ...(repo === undefined ? {} : { target: repo }),
        change: 'creates a copy of the repository; only GitHub web can delete the fork',
        reversible: false,
      }
    case 'push_files':
      return {
        line: `Commit ${count(args?.files)} files to ${text(args?.branch, 'a branch')} in ${text(repo, 'a repository')}`,
        ...(branchTarget(args) === undefined ? {} : { target: branchTarget(args) }),
        change: `commits ${count(args?.files)} files in one commit`,
        reversible: true,
        danger: true,
      }
    default:
      return { line: String(name), change: 'changes something on GitHub', reversible: true }
  }
}

export default {
  id: 'github',
  displayName: 'GitHub',
  mode: 'read-tools',
  url: GITHUB_MCP,
  mcpUrl: GITHUB_MCP,
  api: GITHUB_API,
  tokenSecret: 'GITHUB_TOKEN',
  levels: ['read', 'write'],
  defaultLevel: 'read',
  checkPath: '/user',
  checkHeaders: token => ({
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'ds-bot',
    'X-GitHub-Api-Version': '2022-11-28',
  }),
  accountField: 'login',
  accountOf: user => user?.login,
  readTools: READ_TOOLS,
  actionTools: ACTION_TOOLS,
  // Kept as data for the blocked-name diff and for a framework gate; neither list above
  // contains a blocked name, so the mount cannot offer one.
  blockedTools: BLOCKED_TOOLS,
  actionApproval: (name, args) => approvalFor(name, args),
  capabilities: [
    { key: 'repositories', title: 'Browse repositories, commits and code', risk: 'read' },
    { key: 'issues-read', title: 'Read issues and labels', risk: 'read' },
    { key: 'pull-requests-read', title: 'Read pull requests, reviews and checks', risk: 'read' },
    { key: 'issues-write', title: 'Comment on and manage issues', risk: 'write', preview: { target: 'owner/repo#12', change: 'adds a comment', reversible: true } },
    { key: 'pull-requests-write', title: 'Open and edit pull requests, write reviews', risk: 'write' },
    { key: 'files-write', title: 'Write files and branches', risk: 'destructive', preview: { target: 'owner/repo src/app.js', change: 'commits the file content; the commit history keeps the old content', reversible: true } },
    { key: 'merge', title: 'Merge a pull request', risk: 'destructive', preview: { target: 'owner/repo#12', change: 'merges the pull request; this cannot be undone', reversible: false } },
  ],
  permissions: {
    summary: "Uses the token's own GitHub permissions. Read tools run directly; every write asks for your approval first.",
  },
  card: {
    glyph: 'github',
    about: "Issues, pull requests and repository context through GitHub's own MCP server.",
    docsUrl: 'https://docs.github.com',
    readOnlyNote: 'The read level mounts 23 named read tools. The write level adds 17 tools that ask for approval on every call; ten destructive or credential tools are never offered.',
  },
}
