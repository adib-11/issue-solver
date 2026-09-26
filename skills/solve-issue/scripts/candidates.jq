# Drops issues that are assigned, have an open closing PR, or are mentioned by an
# open PR in the same repo; flattens the rest.
def open_pr: .state == "OPEN";
[ .data.repository.issues.nodes[]
  | select(.assignees.totalCount == 0)
  | select(any(.closedByPullRequestsReferences.nodes[]; open_pr) | not)
  | select(any(.timelineItems.nodes[]; (.isCrossRepository | not) and (.source | open_pr)) | not)
  | { number, title, url,
      labels: [.labels.nodes[].name],
      comments: .comments.totalCount,
      maintainerLastCommentAt: ([.comments.nodes[]
        | select(.authorAssociation | IN("OWNER", "MEMBER", "COLLABORATOR"))
        | .createdAt] | last),
      updatedAt,
      body: (.body // "" | .[0:600]) } ]
