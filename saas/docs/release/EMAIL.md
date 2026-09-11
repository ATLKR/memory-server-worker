# Cloudflare Email Service

검증 메일과 최근 본인 확인 메일은 Cloudflare Email Sending의 네이티브 Worker binding으로 발송한다. 현재 Email Sending은 공개 베타이며, 일반 가입자에게 보내려면 Workers Paid 및 발송 도메인 등록이 필요하다. [Email Service](https://developers.cloudflare.com/email-service/), [발송 한도](https://developers.cloudflare.com/email-service/platform/limits/).

## 서비스 설정

권장 발신자는 `memory@allenlabs.org`이다. Cloudflare DNS에 있는 `allenlabs.org`의 기존 Email **Sending** 등록을 재사용하고, 반환된 DNS 설정을 확인한다. 발송은 `cf-bounce.allenlabs.org`의 MX/SPF, 별도 DKIM selector, DMARC를 사용한다. 기존 수신용 MX를 바꾸는 Email Routing 설정과는 구분한다. [도메인 설정](https://developers.cloudflare.com/email-service/configuration/domains/).

새 발송 도메인은 본문 preview가 기본으로 켜진다. 인증 proof가 Activity Log에 보관되지 않도록 해당 도메인의 `preview_enabled`를 false로 설정한다. 기록된 메시지의 preview 보존 기간은 약 7일이다. [Email preview](https://developers.cloudflare.com/email-service/configuration/domains/#email-preview).

Wrangler 설정:

```jsonc
{
  "send_email": [{
    "name": "EMAIL",
    "allowed_sender_addresses": ["memory@allenlabs.org"]
  }],
  "vars": {
    "MAIL_FROM": "memory@allenlabs.org"
  }
}
```

등록이 완료된 발송 도메인은 일반 수신자에게 보낼 수 있다. 가입자마다 Cloudflare destination 인증을 추가하지 않는다. 발신자 allowlist는 서비스 주소 하나로 제한한다. [Binding 제한](https://developers.cloudflare.com/email-service/configuration/send-bindings/), [일반 수신자 발송](https://developers.cloudflare.com/email-service/platform/limits/#verified-destination-addresses).

도메인 상태는 `GET /zones/{zone_id}/email/sending/subdomains`, DNS 설정은 `GET /zones/{zone_id}/email/sending/subdomains/{subdomain_id}/dns`에서 확인할 수 있다. 도메인 생성은 같은 subdomains collection에 `POST {"name":"example.com"}`를 사용하며, 계정 entitlement가 필요하다. [Email Sending API](https://developers.cloudflare.com/api/resources/email_sending/).

## 애플리케이션 동작

`Admin.mail()`은 `EMAIL.send({from,to,subject,text})`를 호출하고 `messageId`를 확인한다. 런타임 발송용 API secret과 외부 메일 SDK는 필요하지 않다. 현재 공식 structured binding에는 idempotency 필드가 문서화되어 있지 않아 전달 중복 방지를 제공자가 보장한다고 가정하지 않는다. [Workers API](https://developers.cloudflare.com/email-service/api/send-emails/workers-api/).

발송은 인증된 브라우저 세션으로 제한하고 계정당 하루 20회 예산을 유지한다. 애플리케이션은 한 번만 발송을 시도하고 10초 뒤 실패 처리한다. 네이티브 호출 자체를 취소할 수 있다고 가정하지 않는다. 실패·시간 초과 시 최근 본인 확인 challenge를 제거하고 이메일 연결 challenge를 무효화한다. 뒤늦게 메일이 도착해도 그 proof는 사용할 수 없다. proof와 제공자 오류 내용을 HTTP 응답이나 애플리케이션 로그에 출력하지 않는다.

`/ready`와 `/v1/release/config`의 mail 플래그는 binding·발신자 설정 존재 여부만 나타낸다. 실제 수신함 전달·도메인 설정 검증을 대신하지 않는다. 실제 발송 성공이 확인된 뒤 최근 본인 확인 완료, 다른 세션 사용 거부, proof 재사용 거부를 확인한다.

## 로컬 검증

단위·통합 테스트에서는 가짜 `EMAIL.send` binding으로 수신 성공, 제공자 오류, 시간 초과, 일일 예산, proof 폐기를 검증한다. 기본 로컬 Wrangler simulator는 실발송 없이 메일 내용을 콘솔·파일에 기록한다. `remote: true`는 실메일을 발송하므로 일반 로컬 설정에는 넣지 않는다. 실제 주소와 proof를 로컬 로그에서 다루지 않도록 별도의 지정된 시험 환경을 사용한다. [로컬 개발](https://developers.cloudflare.com/email-service/local-development/sending/).

Worker 외부의 도구가 필요할 때는 `POST https://api.cloudflare.com/client/v4/accounts/{account_id}/email/sending/send`와 발송 권한을 가진 Bearer API token을 쓸 수 있다. REST의 수신자별 전달 결과와 binding의 `messageId`는 서로 다른 응답 계약이다. 이 서비스는 binding 경로만 사용한다. [REST API](https://developers.cloudflare.com/email-service/api/send-emails/rest-api/).
