import { defineEventHandler, readBody } from 'h3'

import { PERMISSIONS } from '#shared/constants/rbac'
import { AclBulkPreviewSchema } from '#shared/schemas/acl.schema'
import { aclBulkPreview } from '../../services/acl.service'
import { assertSameOrigin, requirePermission } from '../../utils/auth'
import { apiError, ok } from '../../utils/envelope'

/**
 * POST /api/acl/bulk-preview — classify every row of a bulk ADD (NEW / EXISTS)
 * and build each row's redacted command. Runs an authenticated `acl/show`
 * pre-check per direction but writes NO audit and executes nothing. ADD only, so
 * it always requires ACL_POLICIES_ADD.
 */
export default defineEventHandler(async (event) => {
  assertSameOrigin(event)

  const parsed = AclBulkPreviewSchema.safeParse(await readBody(event))
  if (!parsed.success) {
    throw apiError(400, 'VALIDATION_ERROR', 'Invalid bulk ACL preview request', parsed.error.flatten().fieldErrors)
  }

  await requirePermission(event, PERMISSIONS.ACL_POLICIES_ADD)

  return ok(await aclBulkPreview(parsed.data))
})
