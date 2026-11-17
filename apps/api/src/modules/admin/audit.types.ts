/** Every action the audit log records. One place, so a typo cannot create a second spelling. */
export const AuditAction = {
    LoginSucceeded: 'auth.login',
    LoginFailed: 'auth.login_failed',
    AccountLocked: 'auth.account_locked',
    Logout: 'auth.logout',
    PasswordChanged: 'auth.password_changed',
    PasswordChangeFailed: 'auth.password_change_failed',
    RefreshReuseDetected: 'auth.refresh_reuse_detected',
    StaffCreated: 'staff.created',
    StaffPasswordReset: 'staff.password_reset',
    StaffUpdated: 'staff.updated',
    StaffDeactivated: 'staff.deactivated',
    StaffReactivated: 'staff.reactivated',
    ImportUploaded: 'import.uploaded',
    ImportStarted: 'import.started',
    ImportCompleted: 'import.completed',
    ImportFailed: 'import.failed',
    ImportCancelled: 'import.cancelled',
    ImportReportDownloaded: 'import.report_downloaded',
    SourceKeyCreated: 'source_key.created',
    SourceKeyRevoked: 'source_key.revoked',
    LeadsHandedOver: 'assignment.handover',
    LeadsBulkAssigned: 'assignment.bulk_assign',
    LeadsDistributed: 'assignment.distribute',
    LeaveSet: 'assignment.leave_set',
    LeadsMovedFromPerson: 'assignment.move_from_person',
    LeadCreated: 'lead.created',
    LeadEdited: 'lead.edited',
    LeadsMerged: 'lead.merged',
    LeadsExported: 'lead.exported',
    DoNotContactSet: 'lead.dnc_set',
    DoNotContactCleared: 'lead.dnc_cleared',
    CustomFieldCreated: 'custom_field.created',
    CustomFieldUpdated: 'custom_field.updated',
    CustomValuesEdited: 'lead.custom_edited',
    LeadWonRecorded: 'lead.won',
    EnrolmentUpdated: 'lead.enrolment_updated',
    OutcomeCreated: 'outcome.created',
    OutcomeUpdated: 'outcome.updated',
    LostReasonCreated: 'lost_reason.created',
    LostReasonUpdated: 'lost_reason.updated',
    SettingsChanged: 'settings.changed',
    LeadAnonymised: 'lead.anonymised',
    SourceCreated: 'lead_source.created',
    SourceUpdated: 'lead_source.updated',
} as const;

export type AuditAction = (typeof AuditAction)[keyof typeof AuditAction];

/**
 * One line of the audit log. `detail` holds ids and field names, never personal values: no
 * emails, no names, no passwords or tokens.
 */
export interface AuditEntry {
    action: AuditAction;
    /** The staff user who did it (numeric key). Null when nobody was signed in, e.g. a failed login. */
    actorId: bigint | null;
    entityType: string;
    /** Public id of what was acted on. */
    entityId?: string | null;
    detail?: Record<string, unknown>;
    ip?: string | null;
}

/** What the audit viewer narrows by. `to` is exclusive. */
export interface AuditFilter {
    action?: string;
    actorPublicId?: string;
    entityType?: string;
    entityId?: string;
    from?: Date;
    to?: Date;
}
