import os
import smtplib
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
from email.utils import formatdate, make_msgid
from typing import Optional
import logging

logger = logging.getLogger(__name__)


class EmailService:
    def __init__(self, tenant_settings: Optional[dict] = None):
        if tenant_settings and tenant_settings.get("smtp_host"):
            self.smtp_host = tenant_settings.get("smtp_host")
            self.smtp_port = tenant_settings.get("smtp_port")
            self.smtp_user = tenant_settings.get("smtp_user")
            self.smtp_pass = tenant_settings.get("smtp_pass")
            self.smtp_from = tenant_settings.get("smtp_from")
            self.smtp_tls = tenant_settings.get("smtp_tls", True)
        else:
            self._load_global_settings()

    def _load_global_settings(self):
        """Load global SMTP settings from environment variables."""
        self.smtp_host = os.getenv("AppFactory_SMTP_HOST")
        self.smtp_port = int(os.getenv("AppFactory_SMTP_PORT", "587"))
        self.smtp_user = os.getenv("AppFactory_SMTP_USER")
        self.smtp_pass = os.getenv("AppFactory_SMTP_PASS")
        self.smtp_from = os.getenv("AppFactory_SMTP_FROM", self.smtp_user)
        self.smtp_tls = os.getenv("AppFactory_SMTP_TLS", "true").lower() == "true"

        if self.smtp_host and self.smtp_user and self.smtp_pass:
            logger.info(f"Using global SMTP: {self.smtp_host}")
        else:
            logger.warning("No SMTP settings configured. Email sending will fail.")

    def is_configured(self) -> bool:
        """Check if SMTP is properly configured."""
        return bool(self.smtp_host and self.smtp_user and self.smtp_pass)

    def send_email(self, to_email: str, subject: str, html_body: str) -> bool:
        """Send email using SMTP."""
        if not self.is_configured():
            logger.error(f"SMTP not configured. Cannot send email to {to_email}")
            return False
        try:
            msg = MIMEMultipart("alternative")
            msg["Subject"] = subject
            msg["From"] = self.smtp_from
            msg["To"] = to_email
            msg["Date"] = formatdate(localtime=True)
            msg["Message-ID"] = make_msgid(domain=self.smtp_host or "localhost")

            html_part = MIMEText(html_body, "html")
            msg.attach(html_part)

            with smtplib.SMTP(self.smtp_host, self.smtp_port) as server:
                if self.smtp_tls:
                    server.starttls()
                if self.smtp_user and self.smtp_pass:
                    server.login(self.smtp_user, self.smtp_pass)
                server.send_message(msg)

            logger.info(f"Email sent to {to_email}")
            return True
        except Exception as e:
            logger.error(f"Failed to send email: {e}")
            return False

def send_password_reset_email(
    to_email: str, reset_token: str, frontend_url: str, tenant_name: str = None, tenant_settings: dict | None = None
):
    """Send password reset email with one-time token."""
    reset_link = f"{frontend_url}/reset-password?token={reset_token}"

    tenant_html = (
        f"<p>Tenant: <strong>{tenant_name}</strong></p>" if tenant_name else ""
    )

    html_body = f"""
    <!DOCTYPE html>
    <html>
    <head>
        <style>
            body {{ font-family: Arial, sans-serif; line-height: 1.6; color: #333; }}
            .container {{ max-width: 600px; margin: 0 auto; padding: 20px; }}
            .button {{
                display: inline-block;
                padding: 12px 24px;
                background-color: #4F46E5;
                color: white !important;
                text-decoration: none;
                border-radius: 6px;
                margin: 20px 0;
            }}
            .footer {{ font-size: 12px; color: #666; margin-top: 30px; }}
        </style>
    </head>
    <body>
        <div class="container">
            <h2>Password Reset Request</h2>
            <p>We received a request to reset your password. Click the button below to create a new password:</p>

            <a href="{reset_link}" class="button">Reset Password</a>

            {tenant_html}

            <p>Or copy this link to your browser:<br>
            <a href="{reset_link}">{reset_link}</a></p>

            <p>This link will expire in <strong>15 minutes</strong>.</p>

            <p>If you didn't request this, please ignore this email.</p>

            <div class="footer">
                <p>This is an automated message, please do not reply.</p>
            </div>
        </div>
    </body>
    </html>
    """

    email_service = EmailService(tenant_settings=tenant_settings)
    email_service.send_email(to_email, "Reset Your Password", html_body)
