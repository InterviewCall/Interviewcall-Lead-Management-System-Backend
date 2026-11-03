/**
 * An email in Handlebars source, loaded from the template's .hbs files. `subject` and `text` are
 * plain text (not HTML-escaped); `html` is escaped, so a name like "<b>" cannot inject markup.
 */
export interface EmailTemplate {
    subject: string;
    html: string;
    text: string;
}
