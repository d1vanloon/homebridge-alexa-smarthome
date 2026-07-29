// REVIEW: New GraphQL query for Alexa.ModeController state (modeValue). Uses the `... on Mode { modeValue { value } }`
// inline fragment with subselection — bare modeValue fails with "Subselection required for type 'ModeValue'".
// Analogous to RangeQuery's `... on RangeValue { rangeValue { value } }` pattern.

export const ModeQuery = `query getModeStates(
  $endpointId: String!
) {
  endpoint(id: $endpointId) {
    features {
      name
      instance
      properties {
        name
        ... on Mode {
          modeValue {
            value
          }
        }
      }
    }
  }
}`;
