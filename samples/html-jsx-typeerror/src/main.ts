// This sample is EXPECTED TO FAIL `ts0 build`, and CI asserts that it does.
//
// An HTML entry used to skip type-checking and report success, so a project
// like this one built clean and shipped the error to the browser. The line
// below is the regression guard: if `ts0 build` ever succeeds here again, the
// skip is back.
const answer: number = "forty-two";
console.log(answer);
