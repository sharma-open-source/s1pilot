@auth @P1
Feature: Login

  Background:
    Given I am on the login page

  Scenario: Valid login
    When I sign in as "alice"
    Then I see the dashboard
    And I see a welcome banner

  @slow
  Scenario Outline: Invalid login
    When I sign in as "<user>" with password "<password>"
    Then I see the error "<error>"

    Examples:
      | user  | password | error           |
      | bob   | wrong    | Bad password    |
      | carol |          | Password needed |
