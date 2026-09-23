/**
 * @author Cristono Wijaya
 * @description Signals that registration input failed application-level password policy.
 * @tags Authentication
 * @class InvalidRegistration
 */
export class InvalidRegistration extends Error {}
/**
 * @author Cristono Wijaya
 * @description Signals an account-creation uniqueness conflict without exposing database constraint details.
 * @tags Authentication
 * @class RegistrationConflict
 */
export class RegistrationConflict extends Error {}
