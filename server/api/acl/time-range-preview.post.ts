import { defineEventHandler, readBody } from 'h3'

import { PERMISSIONS } from '#shared/constants/rbac'
import { TimeRangeAddSchema } from '#shared/schemas/time-range.schema'
import { previewTimeRangeAdd } from '../../services/acl.service'
import { assertSameOrigin, requirePermission } from '../../utils/auth'
import { apiError, ok } from '../../utils/envelope'

/**
 * POST /api/acl/time-range-preview — build the display-only command preview for
 * a Time Range ADD (no n8n call, no device change, no audit). Requires
 * ACL_POLICIES_ADD, same as the create it previews.
 */
export default defineEventHandler(async (event) => {
  assertSameOrigin(event)
  await requirePermission(event, PERMISSIONS.ACL_POLICIES_ADD)

  const parsed = TimeRangeAddSchema.safeParse(await readBody(event))
  if (!parsed.success) {
    throw apiError(400, 'VALIDATION_ERROR', 'Invalid time range preview request', parsed.error.flatten().fieldErrors)
  }

  const { text, command } = previewTimeRangeAdd(parsed.data)
  return ok({ preview: text, command })
})
