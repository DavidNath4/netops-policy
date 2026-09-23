import { defineEventHandler, readBody } from 'h3'

import { PERMISSIONS } from '#shared/constants/rbac'
import { AclPreviewSchema } from '#shared/schemas/acl.schema'
import { aclPreview } from '../../services/acl.service'
import { assertSameOrigin, requirePermission } from '../../utils/auth'
import { apiError, ok } from '../../utils/envelope'

/**
 * POST /api/acl/preview — build the redacted command preview for an ACL
 * add/delete (display only, no n8n call, no audit). Permission depends on the
 * operation: ADD → ACL_POLICIES_ADD, DELETE → ACL_POLICIES_DELETE.
 */
export default defineEventHandler(async (event) => {
  assertSameOrigin(event)

  const parsed = AclPreviewSchema.safeParse(await readBody(event))
  if (!parsed.success) {
    throw apiError(400, 'VALIDATION_ERROR', 'Invalid ACL preview request')
  }

  const permission = parsed.data.operation === 'ADD'
    ? PERMISSIONS.ACL_POLICIES_ADD
    : PERMISSIONS.ACL_POLICIES_DELETE
  await requirePermission(event, permission)

  const { text, command } = aclPreview(parsed.data)
  return ok({ preview: text, command })
})
