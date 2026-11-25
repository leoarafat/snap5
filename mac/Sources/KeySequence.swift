import Foundation

/// Decides when "5 5" or "5 5 5" was pressed. Pure logic, so it can be tested without a keyboard.
struct KeySequence {
    enum Result: Equatable {
        case none
        /// Two presses so far: fire "area" if no third press arrives within the interval.
        case waitForThird
        case triple
    }

    var interval: TimeInterval = 0.35
    /// A trigger that follows other typing this closely is part of a word or number, not a command.
    var quietBefore: TimeInterval = 0.8

    private var count = 0
    private var lastTrigger: TimeInterval = -100
    private var lastOther: TimeInterval = -100

    mutating func reset() { count = 0 }

    mutating func otherKey(at time: TimeInterval) {
        lastOther = time
        count = 0
    }

    mutating func triggerKey(at time: TimeInterval) -> Result {
        if time - lastTrigger > interval { count = 0 }
        if count == 0 && time - lastOther < quietBefore {
            lastTrigger = time
            return .none
        }
        lastTrigger = time
        count += 1
        if count >= 3 {
            count = 0
            return .triple
        }
        return count == 2 ? .waitForThird : .none
    }
}
